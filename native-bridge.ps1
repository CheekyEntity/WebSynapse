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
        private const ushort NAGA_V2_PRO_WIRELESS = 0x00A7;
        private const ushort NAGA_V2_PRO_WIRED = 0x00A8;
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
                DeviceInfo selected = ChooseCommandDevice(devices);
                if (selected == null)
                {
                    return Failure("No writable Naga V2 Pro HID feature interface was found. Confirm the mouse is connected by cable.");
                }

                IntPtr handle = OpenDevice(selected.DevicePath, GENERIC_READ | GENERIC_WRITE);
                if (IsInvalid(handle))
                {
                    // Some HID class drivers expose feature reports through a
                    // zero-access handle even when exclusive read/write access
                    // to the standard mouse collection is denied.
                    handle = OpenDevice(selected.DevicePath, 0);
                }
                if (IsInvalid(handle))
                {
                    return Failure("Windows could not open the Naga feature interface: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                }

                activeHandle = handle;
                activeDevice = selected;
                return new BridgeResult { Ok = true, Device = selected };
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

                byte[] report = MakeFeatureBuffer(payload);
                if (report == null)
                {
                    return Failure("The Razer report is " + payload.Length + " bytes, but Windows expects " + activeDevice.FeatureReportLength + " bytes for this interface.");
                }

                if (!HidD_SetFeature(activeHandle, report, report.Length))
                {
                    return Failure("HidD_SetFeature failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                }
                return new BridgeResult { Ok = true };
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

                byte[] report = new byte[activeDevice.FeatureReportLength];
                report[0] = 0x00;
                if (!HidD_GetFeature(activeHandle, report, report.Length))
                {
                    return Failure("HidD_GetFeature failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                }

                if (report.Length == 91)
                {
                    byte[] payload = new byte[90];
                    Array.Copy(report, 1, payload, 0, payload.Length);
                    report = payload;
                }
                return new BridgeResult { Ok = true, Data = Convert.ToBase64String(report) };
            }
        }

        private static byte[] MakeFeatureBuffer(byte[] payload)
        {
            if (payload.Length == activeDevice.FeatureReportLength)
            {
                return payload;
            }
            if (payload.Length + 1 == activeDevice.FeatureReportLength)
            {
                byte[] report = new byte[activeDevice.FeatureReportLength];
                Array.Copy(payload, 0, report, 1, payload.Length);
                return report;
            }
            return null;
        }

        private static DeviceInfo ChooseCommandDevice(List<DeviceInfo> devices)
        {
            DeviceInfo fallback = null;
            foreach (DeviceInfo device in devices)
            {
                if (device.FeatureReportLength < 90)
                {
                    continue;
                }
                if (device.UsagePage == 0x01 && device.Usage == 0x02)
                {
                    return device;
                }
                if (fallback == null)
                {
                    fallback = device;
                }
            }
            return fallback;
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
    try {
        $request = $line | ConvertFrom-Json -ErrorAction Stop
        switch ([string]$request.command) {
            'status' { $result = [WebSynapseNative.HidBridge]::Status() }
            'connect' { $result = [WebSynapseNative.HidBridge]::Connect() }
            'disconnect' { $result = [WebSynapseNative.HidBridge]::Disconnect() }
            'setFeature' { $result = [WebSynapseNative.HidBridge]::SetFeature([string]$request.report) }
            'getFeature' { $result = [WebSynapseNative.HidBridge]::GetFeature() }
            default { throw "Unknown native bridge command: $($request.command)" }
        }
        $response = [ordered]@{
            id = $request.id
            ok = [bool]$result.Ok
            error = $result.Error
            device = $result.Device
            data = $result.Data
            devices = $result.Devices
        }
    } catch {
        $response = [ordered]@{
            id = $null
            ok = $false
            error = $_.Exception.Message
        }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
}
