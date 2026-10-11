# Native Windows HID bridge for the Razer Naga V2 Pro.
# Communicates with server.js over JSON lines on standard input/output.

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace WebSynapseNative
{
    public sealed class DeviceInfo
    {
        public string ProductName;
        public int VendorId;
        public int ProductId;
        public int UsagePage;
        public int Usage;
        public int FeatureReportLength;
        public string DevicePath;
    }

    public sealed class BridgeResult
    {
        public bool Ok;
        public string Error;
        public DeviceInfo Device;
        public string Data;
        public List<DeviceInfo> Devices;
    }

    public static class HidBridge
    {
        private const uint DIGCF_PRESENT = 0x00000002;
        private const uint DIGCF_DEVICEINTERFACE = 0x00000010;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const int ERROR_NO_MORE_ITEMS = 259;
        private const int HIDP_STATUS_SUCCESS = 0x00110000;
        private const ushort RAZER_VENDOR_ID = 0x1532;
        // 0x00A7 is the wired PID, 0x00A8 is the wireless/HyperSpeed-receiver PID
        // (matches OpenRazer's device header and app.js's PRODUCT_IDS mapping).
        private const ushort NAGA_V2_PRO_WIRED = 0x00A7;
        private const ushort NAGA_V2_PRO_WIRELESS = 0x00A8;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);
        private static readonly object Sync = new object();

        private static IntPtr activeHandle = InvalidHandle;
        private static DeviceInfo activeDevice;

        [StructLayout(LayoutKind.Sequential)]
        private struct HiddAttributes
        {
            public int Size;
            public ushort VendorId;
            public ushort ProductId;
            public ushort VersionNumber;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SpDeviceInterfaceData
        {
            public int Size;
            public Guid InterfaceClassGuid;
            public int Flags;
            public IntPtr Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HidpCaps
        {
            public ushort Usage;
            public ushort UsagePage;
            public ushort InputReportByteLength;
            public ushort OutputReportByteLength;
            public ushort FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)]
            public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes;
            public ushort NumberInputButtonCaps;
            public ushort NumberInputValueCaps;
            public ushort NumberInputDataIndices;
            public ushort NumberOutputButtonCaps;
            public ushort NumberOutputValueCaps;
            public ushort NumberOutputDataIndices;
            public ushort NumberFeatureButtonCaps;
            public ushort NumberFeatureValueCaps;
            public ushort NumberFeatureDataIndices;
        }

        [DllImport("hid.dll")]
        private static extern void HidD_GetHidGuid(out Guid hidGuid);

        [DllImport("hid.dll", SetLastError = true)]
        private static extern bool HidD_GetAttributes(IntPtr hidDeviceObject, ref HiddAttributes attributes);

        [DllImport("hid.dll", SetLastError = true)]
        private static extern bool HidD_GetPreparsedData(IntPtr hidDeviceObject, out IntPtr preparsedData);

        [DllImport("hid.dll", SetLastError = true)]
        private static extern bool HidD_FreePreparsedData(IntPtr preparsedData);

        [DllImport("hid.dll", SetLastError = true)]
        private static extern bool HidD_SetFeature(IntPtr hidDeviceObject, byte[] reportBuffer, int reportBufferLength);

        [DllImport("hid.dll", SetLastError = true)]
        private static extern bool HidD_GetFeature(IntPtr hidDeviceObject, byte[] reportBuffer, int reportBufferLength);

        [DllImport("hid.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool HidD_GetProductString(IntPtr hidDeviceObject, StringBuilder buffer, int bufferLength);

        [DllImport("hid.dll")]
        private static extern int HidP_GetCaps(IntPtr preparsedData, out HidpCaps capabilities);

        [DllImport("setupapi.dll", SetLastError = true)]
        private static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, IntPtr enumerator, IntPtr hwndParent, uint flags);

        [DllImport("setupapi.dll", SetLastError = true)]
        private static extern bool SetupDiDestroyDeviceInfoList(IntPtr deviceInfoSet);

        [DllImport("setupapi.dll", SetLastError = true)]
        private static extern bool SetupDiEnumDeviceInterfaces(IntPtr deviceInfoSet, IntPtr deviceInfoData, ref Guid interfaceClassGuid, int memberIndex, ref SpDeviceInterfaceData deviceInterfaceData);

        [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr deviceInfoSet, ref SpDeviceInterfaceData deviceInterfaceData, IntPtr deviceInterfaceDetailData, int deviceInterfaceDetailDataSize, out int requiredSize, IntPtr deviceInfoData);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CreateFile(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static BridgeResult Status()
        {
            lock (Sync)
            {
                return new BridgeResult { Ok = true, Devices = FindSupportedDevices(), Device = activeDevice };
            }
        }

        public static BridgeResult Connect()
        {
            lock (Sync)
            {
                CloseActiveDevice();
                List<DeviceInfo> devices = FindSupportedDevices();
                List<DeviceInfo> candidates = OrderCandidateDevices(devices);
                if (candidates.Count == 0)
                {
                    return Failure("No writable Naga V2 Pro HID feature interface was found. Confirm the mouse is connected by cable.");
                }

                // Tries each candidate in priority order and only commits to one
                // that passes a real SET+GET probe (ProbeDevice), closing the
                // handle and moving on if it doesn't.
                List<string> attemptErrors = new List<string>();
                foreach (DeviceInfo candidate in candidates)
                {
                    IntPtr handle = OpenDevice(candidate.DevicePath, GENERIC_READ | GENERIC_WRITE);
                    if (IsInvalid(handle))
                    {
                        // Some HID class drivers expose feature reports through a
                        // zero-access handle even when exclusive read/write access
                        // to the standard mouse collection is denied.
                        handle = OpenDevice(candidate.DevicePath, 0);
                    }
                    if (IsInvalid(handle))
                    {
                        attemptErrors.Add((candidate.ProductName ?? "Razer interface") + ": could not open (" + new Win32Exception(Marshal.GetLastWin32Error()).Message + ")");
                        continue;
                    }

                    string probeFailure;
                    if (!ProbeDevice(handle, candidate, out probeFailure))
                    {
                        attemptErrors.Add((candidate.ProductName ?? "Razer interface") + ": " + probeFailure);
                        CloseHandle(handle);
                        continue;
                    }

                    activeHandle = handle;
                    activeDevice = candidate;
                    return new BridgeResult { Ok = true, Device = candidate };
                }

                return Failure("No Naga V2 Pro interface responded to a live protocol probe (" + string.Join("; ", attemptErrors) + ").");
            }
        }

        public static BridgeResult Disconnect()
        {
            lock (Sync)
            {
                CloseActiveDevice();
                return new BridgeResult { Ok = true };
            }
        }

        // Status byte values a Razer feature-report response carries at payload
        // offset 0 (matches razercommon.h's RAZER_CMD_* defines).
        private const byte RAZER_STATUS_BUSY = 0x01;
        private const byte RAZER_STATUS_SUCCESSFUL = 0x02;
        private const byte RAZER_STATUS_FAILURE = 0x03;
        private const byte RAZER_STATUS_TIMEOUT = 0x04;
        private const byte RAZER_STATUS_NOT_SUPPORTED = 0x05;

        // The Naga V2 Pro is routed through OpenRazer's
        // RAZER_NEW_MOUSE_RECEIVER_WAIT_US (31000us = 31ms) rather than the
        // default RAZER_MOUSE_WAIT_US (600us). This is the wait between sending
        // a command and reading its response, applied on every attempt.
        // RAZER_RETRY_BACKOFF_MS mirrors razer_send_payload's separate
        // fsleep(10000) between retries of the whole transaction.
        private const int RAZER_RESPONSE_WAIT_MS = 31;
        private const int RAZER_RETRY_BACKOFF_MS = 10;
        private const int SET_FEATURE_MAX_RETRIES = 5;

        public static BridgeResult SetFeature(string reportBase64)
        {
            lock (Sync)
            {
                if (IsInvalid(activeHandle) || activeDevice == null)
                {
                    return Failure("The native HID bridge is not connected.");
                }

                byte[] payload;
                try
                {
                    payload = Convert.FromBase64String(reportBase64);
                }
                catch (FormatException)
                {
                    return Failure("The feature report was not valid base64 data.");
                }

                byte[] report = MakeFeatureBuffer(payload, activeDevice.FeatureReportLength);
                if (report == null)
                {
                    return Failure("The Razer report is " + payload.Length + " bytes, but Windows expects " + activeDevice.FeatureReportLength + " bytes for this interface.");
                }

                byte sentClass = payload.Length > 6 ? payload[6] : (byte)0;
                byte sentId = payload.Length > 7 ? payload[7] : (byte)0;

                // Mirrors OpenRazer's razer_send_payload/razer_get_report pair:
                // each attempt RESENDS the SET, waits RAZER_RESPONSE_WAIT_MS for
                // the device to prepare its response, then reads it back and
                // checks the status byte and the echoed command class/id. The
                // reference retries on every non-success status (not just BUSY)
                // before giving up, so this does the same.
                string lastError = null;
                bool sawAnyStatus = false;
                for (int attempt = 0; attempt < SET_FEATURE_MAX_RETRIES; attempt++)
                {
                    if (attempt > 0)
                    {
                        System.Threading.Thread.Sleep(RAZER_RETRY_BACKOFF_MS);
                    }

                    if (!HidD_SetFeature(activeHandle, report, report.Length))
                    {
                        lastError = "HidD_SetFeature failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                        continue;
                    }

                    System.Threading.Thread.Sleep(RAZER_RESPONSE_WAIT_MS);

                    byte[] responsePayload;
                    try
                    {
                        responsePayload = ReadFeaturePayload();
                    }
                    catch (Exception readEx)
                    {
                        lastError = "Could not read back the device response: " + readEx.Message;
                        continue;
                    }

                    if (responsePayload.Length < 8)
                    {
                        lastError = "The device returned a response shorter than expected.";
                        continue;
                    }

                    byte status = responsePayload[0];
                    byte echoedClass = responsePayload[6];
                    byte echoedId = responsePayload[7];

                    if (echoedClass != sentClass || echoedId != sentId)
                    {
                        // Another transaction's response landed in between (the
                        // queue serialization in app.js should make this rare;
                        // this is the defence-in-depth check).
                        lastError = "The device's response did not match the command that was sent.";
                        continue;
                    }

                    if (status == RAZER_STATUS_SUCCESSFUL)
                    {
                        return new BridgeResult { Ok = true };
                    }

                    sawAnyStatus = true;
                    lastError = DescribeStatus(status);
                }

                if (sawAnyStatus)
                {
                    return Failure("The device did not confirm the command after " + SET_FEATURE_MAX_RETRIES + " attempts (last status: " + lastError + ").");
                }
                return Failure(lastError ?? "The device did not confirm the command after " + SET_FEATURE_MAX_RETRIES + " attempts.");
            }
        }

        private static string DescribeStatus(byte status)
        {
            switch (status)
            {
                case RAZER_STATUS_BUSY: return "the device was busy";
                case RAZER_STATUS_FAILURE: return "the device rejected the command";
                case RAZER_STATUS_TIMEOUT: return "the command timed out on the device";
                case RAZER_STATUS_NOT_SUPPORTED: return "the device does not support this command";
                default: return "an unrecognised status byte 0x" + status.ToString("X2");
            }
        }

        public static BridgeResult GetFeature()
        {
            lock (Sync)
            {
                if (IsInvalid(activeHandle) || activeDevice == null)
                {
                    return Failure("The native HID bridge is not connected.");
                }

                byte[] report;
                try
                {
                    report = ReadFeaturePayload();
                }
                catch (Exception ex)
                {
                    return Failure(ex.Message);
                }

                return new BridgeResult { Ok = true, Data = Convert.ToBase64String(report) };
            }
        }

        /// <summary>
        /// Issues a single HidD_GetFeature call and strips the Windows report-ID
        /// byte, returning the raw 90-byte Razer payload. Shared by GetFeature()
        /// and by SetFeature()'s post-write verification.
        /// Caller must hold Sync.
        /// </summary>
        private static byte[] ReadFeaturePayload()
        {
            byte[] report = new byte[activeDevice.FeatureReportLength];
            report[0] = 0x00;
            if (!HidD_GetFeature(activeHandle, report, report.Length))
            {
                throw new InvalidOperationException("HidD_GetFeature failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
            }

            if (report.Length == 91)
            {
                byte[] payload = new byte[90];
                Array.Copy(report, 1, payload, 0, payload.Length);
                report = payload;
            }
            return report;
        }

        // Takes an explicit feature-report length so the connect-time probe can
        // use it before any device has been committed to.
        private static byte[] MakeFeatureBuffer(byte[] payload, int featureReportLength)
        {
            if (payload.Length == featureReportLength)
            {
                return payload;
            }
            if (payload.Length + 1 == featureReportLength)
            {
                byte[] report = new byte[featureReportLength];
                Array.Copy(payload, 0, report, 1, payload.Length);
                return report;
            }
            return null;
        }

        // Returns every plausible candidate in priority order; Connect()
        // live-probes each one in turn with a real SET+GET round trip, the same
        // standard the WebHID path uses in app.js.
        private static List<DeviceInfo> OrderCandidateDevices(List<DeviceInfo> devices)
        {
            List<DeviceInfo> preferred = new List<DeviceInfo>();
            List<DeviceInfo> fallback = new List<DeviceInfo>();
            foreach (DeviceInfo device in devices)
            {
                if (device.FeatureReportLength < 90)
                {
                    continue;
                }
                if (device.UsagePage == 0x01 && device.Usage == 0x02)
                {
                    preferred.Add(device);
                }
                else
                {
                    fallback.Add(device);
                }
            }
            preferred.AddRange(fallback);
            return preferred;
        }

        // Builds the same "get polling rate" probe report app.js uses to
        // validate a WebHID interface, so both connection paths apply the
        // identical live-protocol check.
        private static byte[] BuildProbeReport()
        {
            byte[] report = new byte[90];
            report[0] = 0x00; // status
            report[1] = 0x1F; // transaction_id
            report[5] = 0x01; // data size
            report[6] = 0x00; // command class
            report[7] = 0x85; // command id (get polling rate)
            byte crc = 0;
            for (int i = 2; i < 88; i++) crc ^= report[i];
            report[88] = crc;
            return report;
        }

        private static bool ProbeDevice(IntPtr handle, DeviceInfo device, out string failureReason)
        {
            failureReason = null;
            byte[] probeReport = MakeFeatureBuffer(BuildProbeReport(), device.FeatureReportLength);
            if (probeReport == null)
            {
                failureReason = "the probe report size did not match this interface's feature report length";
                return false;
            }
            if (!HidD_SetFeature(handle, probeReport, probeReport.Length))
            {
                failureReason = "HidD_SetFeature failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                return false;
            }

            System.Threading.Thread.Sleep(RAZER_RESPONSE_WAIT_MS);

            byte[] response = new byte[device.FeatureReportLength];
            response[0] = 0x00;
            if (!HidD_GetFeature(handle, response, response.Length))
            {
                failureReason = "HidD_GetFeature failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                return false;
            }
            if (response.Length == 91)
            {
                byte[] payload = new byte[90];
                Array.Copy(response, 1, payload, 0, payload.Length);
                response = payload;
            }
            if (response.Length < 8 || response[6] != 0x00 || response[7] != 0x85)
            {
                failureReason = "the interface did not echo a valid Razer response to the probe command";
                return false;
            }
            return true;
        }

        private static List<DeviceInfo> FindSupportedDevices()
        {
            List<DeviceInfo> devices = new List<DeviceInfo>();
            Guid hidGuid;
            HidD_GetHidGuid(out hidGuid);
            IntPtr deviceInfoSet = SetupDiGetClassDevs(ref hidGuid, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
            if (IsInvalid(deviceInfoSet))
            {
                return devices;
            }

            try
            {
                for (int index = 0; ; index++)
                {
                    SpDeviceInterfaceData interfaceData = new SpDeviceInterfaceData();
                    interfaceData.Size = Marshal.SizeOf(typeof(SpDeviceInterfaceData));
                    if (!SetupDiEnumDeviceInterfaces(deviceInfoSet, IntPtr.Zero, ref hidGuid, index, ref interfaceData))
                    {
                        if (Marshal.GetLastWin32Error() == ERROR_NO_MORE_ITEMS)
                        {
                            break;
                        }
                        continue;
                    }

                    string devicePath = GetDevicePath(deviceInfoSet, ref interfaceData);
                    if (String.IsNullOrEmpty(devicePath))
                    {
                        continue;
                    }

                    IntPtr handle = OpenDevice(devicePath, 0);
                    if (IsInvalid(handle))
                    {
                        continue;
                    }

                    try
                    {
                        HiddAttributes attributes = new HiddAttributes();
                        attributes.Size = Marshal.SizeOf(typeof(HiddAttributes));
                        if (!HidD_GetAttributes(handle, ref attributes) || attributes.VendorId != RAZER_VENDOR_ID || (attributes.ProductId != NAGA_V2_PRO_WIRELESS && attributes.ProductId != NAGA_V2_PRO_WIRED))
                        {
                            continue;
                        }

                        HidpCaps caps;
                        if (!TryGetCapabilities(handle, out caps))
                        {
                            continue;
                        }

                        devices.Add(new DeviceInfo {
                            ProductName = GetProductName(handle),
                            VendorId = attributes.VendorId,
                            ProductId = attributes.ProductId,
                            UsagePage = caps.UsagePage,
                            Usage = caps.Usage,
                            FeatureReportLength = caps.FeatureReportByteLength,
                            DevicePath = devicePath
                        });
                    }
                    finally
                    {
                        CloseHandle(handle);
                    }
                }
            }
            finally
            {
                SetupDiDestroyDeviceInfoList(deviceInfoSet);
            }
            return devices;
        }

        private static bool TryGetCapabilities(IntPtr handle, out HidpCaps caps)
        {
            caps = new HidpCaps();
            IntPtr preparsedData = IntPtr.Zero;
            try
            {
                if (!HidD_GetPreparsedData(handle, out preparsedData))
                {
                    return false;
                }
                return HidP_GetCaps(preparsedData, out caps) == HIDP_STATUS_SUCCESS;
            }
            finally
            {
                if (preparsedData != IntPtr.Zero)
                {
                    HidD_FreePreparsedData(preparsedData);
                }
            }
        }

        private static string GetProductName(IntPtr handle)
        {
            StringBuilder name = new StringBuilder(256);
            return HidD_GetProductString(handle, name, name.Capacity * 2) ? name.ToString() : "Razer Naga V2 Pro";
        }

        private static string GetDevicePath(IntPtr deviceInfoSet, ref SpDeviceInterfaceData interfaceData)
        {
            int requiredSize;
            SetupDiGetDeviceInterfaceDetail(deviceInfoSet, ref interfaceData, IntPtr.Zero, 0, out requiredSize, IntPtr.Zero);
            if (requiredSize <= 0)
            {
                return null;
            }

            IntPtr detailData = Marshal.AllocHGlobal(requiredSize);
            try
            {
                Marshal.WriteInt32(detailData, IntPtr.Size == 8 ? 8 : 6);
                if (!SetupDiGetDeviceInterfaceDetail(deviceInfoSet, ref interfaceData, detailData, requiredSize, out requiredSize, IntPtr.Zero))
                {
                    return null;
                }
                return Marshal.PtrToStringAuto(IntPtr.Add(detailData, 4));
            }
            finally
            {
                Marshal.FreeHGlobal(detailData);
            }
        }

        private static IntPtr OpenDevice(string devicePath, uint desiredAccess)
        {
            return CreateFile(devicePath, desiredAccess, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        }

        private static void CloseActiveDevice()
        {
            if (!IsInvalid(activeHandle))
            {
                CloseHandle(activeHandle);
            }
            activeHandle = InvalidHandle;
            activeDevice = null;
        }

        private static bool IsInvalid(IntPtr handle)
        {
            return handle == IntPtr.Zero || handle == InvalidHandle;
        }

        private static BridgeResult Failure(string message)
        {
            return new BridgeResult { Ok = false, Error = message };
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -ErrorAction Stop

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while (($line = [Console]::In.ReadLine()) -ne $null) {
    $response = $null
    # Remember the request id outside the try so an error response can carry it;
    # otherwise server.js never matches the reply to its pending request.
    $requestId = $null
    try {
        $request = $line | ConvertFrom-Json -ErrorAction Stop
        $requestId = $request.id
        switch ([string]$request.command) {
            'status' { $result = [WebSynapseNative.HidBridge]::Status() }
            'connect' { $result = [WebSynapseNative.HidBridge]::Connect() }
            'disconnect' { $result = [WebSynapseNative.HidBridge]::Disconnect() }
            'setFeature' { $result = [WebSynapseNative.HidBridge]::SetFeature([string]$request.report) }
            'getFeature' { $result = [WebSynapseNative.HidBridge]::GetFeature() }
            default { throw "Unknown native bridge command: $($request.command)" }
        }
        $response = [ordered]@{
            id = $requestId
            ok = [bool]$result.Ok
            error = $result.Error
            device = $result.Device
            data = $result.Data
            devices = $result.Devices
        }
    } catch {
        $response = [ordered]@{
            id = $requestId
            ok = $false
            error = $_.Exception.Message
        }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
}
