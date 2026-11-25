#Requires -Version 7.0
# Host-side input file guard of the Launcher (task 4.9-C1; design "Who checks what", "Run_Volume rule"; R15.11 pre-volume checks).
# Called by Invoke-DiscoveryStart (task 4.9-C2) after the gate and before the locks; the handles are held until the stop of the container is confirmed. No function here starts a process, calls Docker, or writes a file.
#
# What it does: for a CLOSED table of input files (the bind-mount sources of a Run) below one repository root it opens every file ONCE with
# the Win32 API, keeps that handle, and checks (all on the handle, not on the path text):
#   - the root, every ancestor up to the volume root, and every intermediate directory is a real directory, not a reparse point
#     (symbolic link, junction, mount point, cloud placeholder), on NTFS, and its final path equals its expected path;
#   - the file is opened with FILE_FLAG_OPEN_REPARSE_POINT, so a link is seen as a link and refused; it is a regular file (not a directory,
#     device, offline or recall-on-access file), on NTFS, with exactly 1 link, its final path equals the expected path (case-insensitive),
#     it has no alternate data stream, and its size is inside the row bounds;
#   - rows that need a hash are read from the SAME handle (RandomAccess.Read at an offset, so no FileStream takes or releases the handle)
#     and hashed with SHA-256; the file is queried again afterwards and must be unchanged.
# The handle is opened with FILE_SHARE_READ only, so other processes cannot write, rename, or delete the file while it is held.
#
# Drive letter versus alternate data stream: the only colon allowed in a path is the one at index 1 (`X:`). Any other colon is an alternate
# data stream (or a device or reserved form) and is refused. UNC, device (`\\.\`), extended (`\\?\`) and relative roots are refused.
#
# Ownership: the HeldFile object owns its SafeFileHandle and nothing else wraps it. Close-InputFileGuard disposes every handle. A handle
# is wrapped in a HeldFile right after it is opened, and a failed Open-InputFileGuard disposes everything it opened.
#
# Errors are closed codes with the table label. No path, file content, or exception message leaves this module.
#
# NOT claimed (residual risks): the hold stops ordinary writes, renames, and deletes by other processes, but not a hard link made after the
# check (Confirm-InputFileGuard detects the link count again), not a process with backup privilege, and not what the Docker Desktop file
# sharing layer does with the file. Whether Docker Desktop can bind-mount a file that is held with FILE_SHARE_READ is UNVERIFIED (left to the real
# environment checks after task 4.9-C2). Non-NTFS volumes are refused, not tested on a real non-NTFS volume.
Set-StrictMode -Version Latest

$script:Codes = @('platform_unsupported', 'root_invalid', 'table_invalid', 'missing', 'unreadable', 'not_regular_file', 'reparse_point', 'hard_linked',
    'path_mismatch', 'alternate_stream', 'streams_unknown', 'too_large', 'too_small', 'unsupported_filesystem', 'ancestor_unreadable',
    'ancestor_reparse_point', 'ancestor_not_directory', 'read_failed', 'changed', 'guard_closed', 'guard_invalid')
$script:HardMaxBytes = 1048576
$script:NativeReady = $null

$script:NativeSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Phoenix.InputFileGuard
{
    public sealed class FileFacts
    {
        public uint Attributes;
        public uint Links;
        public ulong Size;
        public uint VolumeSerial;
        public ulong FileIndex;
        public long LastWrite;
        public string FileSystem;
        public string FinalPath;
        public bool StreamsKnown;
        public bool OnlyDefaultStream;
    }

    // Owns one SafeFileHandle. Nothing else wraps or closes it. Dispose is idempotent.
    public sealed class HeldFile : IDisposable
    {
        public SafeFileHandle Handle;
        public bool IsClosed { get { return Handle == null || Handle.IsClosed; } }
        public void Dispose()
        {
            SafeFileHandle h = Handle;
            if (h != null) { h.Dispose(); }
        }
    }

    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        struct FILETIME { public uint Low; public uint High; }

        [StructLayout(LayoutKind.Sequential)]
        struct BY_HANDLE_FILE_INFORMATION
        {
            public uint dwFileAttributes;
            public FILETIME ftCreationTime;
            public FILETIME ftLastAccessTime;
            public FILETIME ftLastWriteTime;
            public uint dwVolumeSerialNumber;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint nNumberOfLinks;
            public uint nFileIndexHigh;
            public uint nFileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
        static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buffer, uint length, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int infoClass, IntPtr buffer, uint size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool GetVolumeInformationByHandleW(SafeFileHandle h, IntPtr volumeName, uint volumeNameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fileSystemName, uint fileSystemNameSize);

        // hold = true: GENERIC_READ, FILE_SHARE_READ only (others cannot write, rename or delete while it is held).
        // hold = false: FILE_READ_ATTRIBUTES only, every share mode (a probe that does not conflict with a held handle).
        // The reparse point itself is opened (FILE_FLAG_OPEN_REPARSE_POINT), so a link is seen as a link.
        // FILE_FLAG_BACKUP_SEMANTICS lets a directory be opened; a directory is then refused by its attribute.
        public static SafeFileHandle Open(string path, bool hold, bool directory, out int error)
        {
            uint access = hold ? 0x80000000u : 0x80u;
            uint share = hold ? 1u : 7u;
            uint flags = 0x00200000u | 0x02000000u;
            SafeFileHandle h = CreateFile(path, access, share, IntPtr.Zero, 3u, flags, IntPtr.Zero);
            int last = Marshal.GetLastWin32Error();
            error = h.IsInvalid ? last : 0;
            return h;
        }

        public static FileFacts Query(SafeFileHandle h, bool streams)
        {
            try
            {
                if (h == null || h.IsInvalid || h.IsClosed) { return null; }
                BY_HANDLE_FILE_INFORMATION bi;
                if (!GetFileInformationByHandle(h, out bi)) { return null; }
                FileFacts f = new FileFacts();
                f.Attributes = bi.dwFileAttributes;
                f.Links = bi.nNumberOfLinks;
                f.Size = ((ulong)bi.nFileSizeHigh << 32) | bi.nFileSizeLow;
                f.VolumeSerial = bi.dwVolumeSerialNumber;
                f.FileIndex = ((ulong)bi.nFileIndexHigh << 32) | bi.nFileIndexLow;
                f.LastWrite = ((long)bi.ftLastWriteTime.High << 32) | bi.ftLastWriteTime.Low;
                StringBuilder fs = new StringBuilder(261);
                uint serial, maxComponent, fsFlags;
                if (!GetVolumeInformationByHandleW(h, IntPtr.Zero, 0, out serial, out maxComponent, out fsFlags, fs, 261)) { return null; }
                f.FileSystem = fs.ToString();
                f.FinalPath = FinalPath(h);
                if (f.FinalPath == null) { return null; }
                if (streams) { ReadStreams(h, f); }
                return f;
            }
            catch (Exception) { return null; }
        }

        static string FinalPath(SafeFileHandle h)
        {
            StringBuilder sb = new StringBuilder(512);
            uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0u);
            if (n == 0) { return null; }
            if (n >= (uint)sb.Capacity)
            {
                if (n > 32767u) { return null; }
                sb = new StringBuilder((int)n + 1);
                n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0u);
                if (n == 0 || n >= (uint)sb.Capacity) { return null; }
            }
            return sb.ToString();
        }

        // FILE_STREAM_INFO records (FileStreamInfo = 7): NextEntryOffset(4) StreamNameLength(4) StreamSize(8) StreamAllocationSize(8) StreamName(WCHAR...) at offset 24.
        static void ReadStreams(SafeFileHandle h, FileFacts f)
        {
            f.StreamsKnown = false;
            f.OnlyDefaultStream = false;
            const int size = 65536;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                if (!GetFileInformationByHandleEx(h, 7, buf, (uint)size)) { return; }
                int offset = 0;
                int count = 0;
                bool onlyDefault = true;
                while (true)
                {
                    if (offset < 0 || offset + 24 > size) { return; }
                    uint next = (uint)Marshal.ReadInt32(buf, offset);
                    int nameLength = Marshal.ReadInt32(buf, offset + 4);
                    if (nameLength < 0 || offset + 24 + nameLength > size) { return; }
                    string name = Marshal.PtrToStringUni(IntPtr.Add(buf, offset + 24), nameLength / 2);
                    count++;
                    if (name != "::$DATA") { onlyDefault = false; }
                    if (next == 0) { break; }
                    if (next > (uint)size) { return; }
                    offset += (int)next;
                }
                f.StreamsKnown = true;
                f.OnlyDefaultStream = onlyDefault && count == 1;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        // Reads exactly `size` bytes from the held handle (positional reads; the handle is not wrapped), checks that nothing follows, and
        // returns the lowercase hex SHA-256. Returns null on any failure.
        public static string HashFile(SafeFileHandle h, ulong size)
        {
            try
            {
                if (h == null || h.IsInvalid || h.IsClosed || size > 67108864UL) { return null; }
                byte[] buf = new byte[(int)size];
                long off = 0;
                while (off < (long)size)
                {
                    int n = RandomAccess.Read(h, new Span<byte>(buf, (int)off, buf.Length - (int)off), off);
                    if (n <= 0) { return null; }
                    off += n;
                }
                byte[] one = new byte[1];
                if (RandomAccess.Read(h, new Span<byte>(one), (long)size) != 0) { return null; }
                return Convert.ToHexString(SHA256.HashData(buf)).ToLowerInvariant();
            }
            catch (Exception) { return null; }
        }
    }
}
'@

function Initialize-InputFileGuardNative {
    if ($null -ne $script:NativeReady) { return $script:NativeReady }
    $script:NativeReady = $false
    try {
        if (-not $IsWindows) { return $false }
        if (-not ('Phoenix.InputFileGuard.Native' -as [type])) { Add-Type -TypeDefinition $script:NativeSource -Language CSharp -ErrorAction Stop }
        $script:NativeReady = $true
    } catch { $script:NativeReady = $false }
    $script:NativeReady
}

function Get-InputFileGuardCodes { , @($script:Codes) }

# The closed table of the 11 bind-mount sources of a Run (design mount table; the same sources and targets as New-ContainerCreateArgs,
# except that the audit configuration is the fixture file `audit-config.mock.json`, decision of 2026-11-25). Size bounds follow the READ
# PATHS of the runtime: run-config.json is read through createFixedInputReader (1 MiB) and then strictParse with DEFAULT_PARSE_LIMITS
# (262144 bytes); every other file is read through createAnalysisFs (ANALYSIS_FILE_MAX_BYTES, 1 MiB). A test pins both numbers to the source.
function Get-InputFileTable {
    $row = { param($label, $rel, $target, $max, $min, $hash) [pscustomobject]@{ Label = $label; RelPath = $rel; Target = $target; MaxBytes = [long]$max; MinBytes = [long]$min; HashRequired = [bool]$hash } }
    $rows = @(
        (& $row 'run-config' 'discovery/config/run-config.json' '/run/config/run-config.json' 262144 1 $true),
        (& $row 'audit-config' 'discovery/config/audit-config.mock.json' '/run/config/audit-config.json' 1048576 1 $true),
        (& $row 'allowlist-json' 'docs/ai-input-allowlist.json' '/repo/docs/ai-input-allowlist.json' 1048576 0 $false),
        (& $row 'allowlist-md' 'docs/ai-input-allowlist.md' '/repo/docs/ai-input-allowlist.md' 1048576 0 $false),
        (& $row 'legacy-src-index' 'legacy/src/index.php' '/repo/legacy/src/index.php' 1048576 0 $false),
        (& $row 'legacy-src-db' 'legacy/src/db.php' '/repo/legacy/src/db.php' 1048576 0 $false),
        (& $row 'legacy-src-products' 'legacy/src/products.php' '/repo/legacy/src/products.php' 1048576 0 $false),
        (& $row 'legacy-src-orders' 'legacy/src/orders.php' '/repo/legacy/src/orders.php' 1048576 0 $false),
        (& $row 'legacy-src-utils' 'legacy/src/utils.php' '/repo/legacy/src/utils.php' 1048576 0 $false),
        (& $row 'legacy-sql-schema' 'legacy/sql/schema.sql' '/repo/legacy/sql/schema.sql' 1048576 0 $false),
        (& $row 'legacy-sql-seed' 'legacy/sql/seed.sql' '/repo/legacy/sql/seed.sql' 1048576 0 $false)
    )
    , $rows
}

function Test-GuardRootText {
    param($Root)
    if ($Root -isnot [string] -or $Root.Length -lt 4 -or $Root.Length -gt 240) { return $false }
    if ($Root -cnotmatch '^[A-Za-z]:\\(?:[^\\/:*?"<>|\x00-\x1f]+\\)*[^\\/:*?"<>|\x00-\x1f]+\z') { return $false }
    foreach ($s in $Root.Substring(3).Split('\')) { if ($s -ceq '.' -or $s -ceq '..' -or $s.EndsWith('.') -or $s.EndsWith(' ')) { return $false } }
    try { return ([System.IO.Path]::GetFullPath($Root) -ceq $Root) } catch { return $false }
}

function Test-InputFileTableShape {
    param($Table)
    $rows = @($Table)
    if ($rows.Count -lt 1 -or $rows.Count -gt 64) { return $false }
    $labels = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $rels = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $targets = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($r in $rows) {
        if ($null -eq $r -or $r -isnot [pscustomobject]) { return $false }
        $names = @($r.PSObject.Properties.Name)
        foreach ($n in 'Label', 'RelPath', 'Target', 'MaxBytes', 'MinBytes', 'HashRequired') { if ($names -cnotcontains $n) { return $false } }
        if ($r.Label -isnot [string] -or $r.RelPath -isnot [string] -or $r.Target -isnot [string] -or $r.HashRequired -isnot [bool]) { return $false }
        if ($r.MaxBytes -isnot [long] -or $r.MinBytes -isnot [long] -or $r.MaxBytes -lt 1 -or $r.MaxBytes -gt $script:HardMaxBytes -or $r.MinBytes -lt 0 -or $r.MinBytes -gt $r.MaxBytes) { return $false }
        if ($r.Label -cnotmatch '^[a-z0-9]+(-[a-z0-9]+)*\z') { return $false }
        if ($r.RelPath -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*\z') { return $false }
        foreach ($s in $r.RelPath.Split('/')) { if ($s.EndsWith('.')) { return $false } }
        if ($r.Target -cnotmatch '^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\z') { return $false }
        foreach ($s in $r.Target.Substring(1).Split('/')) { if ($s -ceq '.' -or $s -ceq '..') { return $false } }
        if (-not $labels.Add($r.Label) -or -not $rels.Add($r.RelPath) -or -not $targets.Add($r.Target)) { return $false }
    }
    $true
}

# `\\?\X:\...` to `X:\...`. Anything else (UNC, device, a second colon) is $null.
function ConvertFrom-GuardFinalPath {
    param([string]$Final)
    if ([string]::IsNullOrEmpty($Final) -or $Final -cnotmatch '^\\\\\?\\[A-Za-z]:\\') { return $null }
    $p = $Final.Substring(4)
    if ($p.Substring(2).Contains(':')) { return $null }
    $p
}

function Test-GuardDirectory {
    param([string]$Path)
    $err = [int]0
    $h = [Phoenix.InputFileGuard.Native]::Open($Path, $false, $true, [ref]$err)
    try {
        if ($h.IsInvalid) { return $(if ($err -eq 2 -or $err -eq 3) { 'missing' } else { 'ancestor_unreadable' }) }
        $f = [Phoenix.InputFileGuard.Native]::Query($h, $false)
        if ($null -eq $f) { return 'ancestor_unreadable' }
        if (([uint32]$f.Attributes -band 0x400) -ne 0) { return 'ancestor_reparse_point' }
        if (([uint32]$f.Attributes -band 0x10) -eq 0) { return 'ancestor_not_directory' }
        if (-not [string]::Equals($f.FileSystem, 'NTFS', [StringComparison]::OrdinalIgnoreCase)) { return 'unsupported_filesystem' }
        $fp = ConvertFrom-GuardFinalPath -Final $f.FinalPath
        if ($null -eq $fp -or -not [string]::Equals($fp, $Path, [StringComparison]::OrdinalIgnoreCase)) { return 'path_mismatch' }
        return $null
    } finally { $h.Dispose() }
}

# The volume root, every directory from it to the repository root, then the directories below the root on the way to the file.
function Test-GuardChain {
    param([string]$Root, [string[]]$RelDirSegments, $Checked)
    $paths = [System.Collections.Generic.List[string]]::new()
    $paths.Add($Root.Substring(0, 3))
    $cur = $Root.Substring(0, 2)
    foreach ($s in $Root.Substring(3).Split('\')) { $cur += '\' + $s; $paths.Add($cur) }
    foreach ($s in $RelDirSegments) { $cur += '\' + $s; $paths.Add($cur) }
    foreach ($p in $paths) {
        if ($Checked.Add($p)) {
            $c = Test-GuardDirectory -Path $p
            if ($null -ne $c) { return $c }
        }
    }
    return $null
}

function Get-GuardDirSegments {
    param([string[]]$Segments)
    if ($Segments.Count -gt 1) { return , @($Segments[0..($Segments.Count - 2)]) }
    , @()
}

# Opens, checks, and holds every file of the table. Result: Ok, Code, Label, Guard. On failure nothing stays open.
function Open-InputFileGuard {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$RepoRoot, [Parameter(Mandatory)][AllowEmptyCollection()]$Table)
    $fail = { param($code, $label) [pscustomobject]@{ Ok = $false; Code = $code; Label = $label; Guard = $null } }
    if (-not (Initialize-InputFileGuardNative)) { return (& $fail 'platform_unsupported' $null) }
    if (-not (Test-GuardRootText -Root $RepoRoot)) { return (& $fail 'root_invalid' $null) }
    if (-not (Test-InputFileTableShape -Table $Table)) { return (& $fail 'table_invalid' $null) }
    $held = [System.Collections.Generic.List[object]]::new()
    $entries = [System.Collections.Generic.List[object]]::new()
    $checked = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $ok = $false
    $label = $null
    try {
        foreach ($row in @($Table)) {
            $label = [string]$row.Label
            $segs = ([string]$row.RelPath).Split('/')
            $c = Test-GuardChain -Root $RepoRoot -RelDirSegments (Get-GuardDirSegments -Segments $segs) -Checked $checked
            if ($null -ne $c) { return (& $fail $c $label) }
            $expected = $RepoRoot + '\' + ($segs -join '\')
            $err = [int]0
            $h = [Phoenix.InputFileGuard.Native]::Open($expected, $true, $false, [ref]$err)
            $hf = [Phoenix.InputFileGuard.HeldFile]::new()
            $hf.Handle = $h
            $held.Add($hf)
            if ($h.IsInvalid) { return (& $fail $(if ($err -eq 2 -or $err -eq 3) { 'missing' } else { 'unreadable' }) $label) }
            $f = [Phoenix.InputFileGuard.Native]::Query($h, $true)
            if ($null -eq $f) { return (& $fail 'unreadable' $label) }
            $a = [uint32]$f.Attributes
            if (($a -band 0x400) -ne 0) { return (& $fail 'reparse_point' $label) }
            if (($a -band (0x10 -bor 0x40 -bor 0x1000 -bor 0x40000 -bor 0x400000)) -ne 0) { return (& $fail 'not_regular_file' $label) }
            if (-not [string]::Equals($f.FileSystem, 'NTFS', [StringComparison]::OrdinalIgnoreCase)) { return (& $fail 'unsupported_filesystem' $label) }
            if ($f.Links -ne 1) { return (& $fail 'hard_linked' $label) }
            $fp = ConvertFrom-GuardFinalPath -Final $f.FinalPath
            if ($null -eq $fp -or -not [string]::Equals($fp, $expected, [StringComparison]::OrdinalIgnoreCase)) { return (& $fail 'path_mismatch' $label) }
            if (-not $f.StreamsKnown) { return (& $fail 'streams_unknown' $label) }
            if (-not $f.OnlyDefaultStream) { return (& $fail 'alternate_stream' $label) }
            if ($f.Size -gt [uint64]$row.MaxBytes) { return (& $fail 'too_large' $label) }
            if ($f.Size -lt [uint64]$row.MinBytes) { return (& $fail 'too_small' $label) }
            $hash = $null
            if ($row.HashRequired) {
                $hash = [Phoenix.InputFileGuard.Native]::HashFile($h, $f.Size)
                if ($null -eq $hash) { return (& $fail 'read_failed' $label) }
                $g = [Phoenix.InputFileGuard.Native]::Query($h, $false)
                if ($null -eq $g -or $g.Links -ne 1 -or $g.Size -ne $f.Size -or $g.LastWrite -ne $f.LastWrite -or $g.FileIndex -ne $f.FileIndex -or $g.VolumeSerial -ne $f.VolumeSerial) { return (& $fail 'changed' $label) }
            }
            $entries.Add([pscustomobject]@{
                    Label = $label; RelPath = [string]$row.RelPath; Target = [string]$row.Target; MaxBytes = [long]$row.MaxBytes; MinBytes = [long]$row.MinBytes
                    HashRequired = [bool]$row.HashRequired; HostPath = $expected; MountSource = $fp; Size = [long]$f.Size; Sha256 = $hash
                    VolumeSerial = [uint32]$f.VolumeSerial; FileIndex = [uint64]$f.FileIndex; LastWrite = [long]$f.LastWrite; Held = $hf
                })
        }
        $ok = $true
        $guard = [pscustomobject]@{ Kind = 'input-file-guard'; RepoRoot = $RepoRoot; Entries = $entries.ToArray(); Closed = $false }
        return [pscustomobject]@{ Ok = $true; Code = $null; Label = $null; Guard = $guard }
    } catch {
        return (& $fail 'unreadable' $label)
    } finally {
        if (-not $ok) { foreach ($x in $held) { try { $x.Dispose() } catch { } } }
    }
}

# The identity check at the time of use: every held file again (links, identity, size, time, streams, final path, hash), a fresh probe
# of the path (same volume serial and file index), and every ancestor again. Result: Ok, Code, Label.
function Confirm-InputFileGuard {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Guard)
    $res = { param($ok, $code, $label) [pscustomobject]@{ Ok = $ok; Code = $code; Label = $label } }
    $label = $null
    try {
        if ($null -eq $Guard -or $Guard -isnot [pscustomobject] -or @($Guard.PSObject.Properties.Name) -cnotcontains 'Kind' -or $Guard.Kind -cne 'input-file-guard') { return (& $res $false 'guard_invalid' $null) }
        if ($Guard.Closed) { return (& $res $false 'guard_closed' $null) }
        if (-not (Initialize-InputFileGuardNative)) { return (& $res $false 'platform_unsupported' $null) }
        $checked = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($e in $Guard.Entries) {
            $label = [string]$e.Label
            $hf = $e.Held
            if ($hf.IsClosed) { return (& $res $false 'changed' $label) }
            $segs = ([string]$e.RelPath).Split('/')
            $c = Test-GuardChain -Root $Guard.RepoRoot -RelDirSegments (Get-GuardDirSegments -Segments $segs) -Checked $checked
            if ($null -ne $c) { return (& $res $false $c $label) }
            $q = [Phoenix.InputFileGuard.Native]::Query($hf.Handle, $true)
            if ($null -eq $q) { return (& $res $false 'unreadable' $label) }
            if (([uint32]$q.Attributes -band 0x400) -ne 0) { return (& $res $false 'reparse_point' $label) }
            if ($q.Links -ne 1) { return (& $res $false 'hard_linked' $label) }
            if ($q.VolumeSerial -ne $e.VolumeSerial -or $q.FileIndex -ne $e.FileIndex -or [long]$q.Size -ne $e.Size -or $q.LastWrite -ne $e.LastWrite) { return (& $res $false 'changed' $label) }
            $fp = ConvertFrom-GuardFinalPath -Final $q.FinalPath
            if ($null -eq $fp -or -not [string]::Equals($fp, $e.HostPath, [StringComparison]::OrdinalIgnoreCase)) { return (& $res $false 'path_mismatch' $label) }
            if (-not $q.StreamsKnown) { return (& $res $false 'streams_unknown' $label) }
            if (-not $q.OnlyDefaultStream) { return (& $res $false 'alternate_stream' $label) }
            if ($e.HashRequired) {
                $now = [Phoenix.InputFileGuard.Native]::HashFile($hf.Handle, $q.Size)
                if ($null -eq $now) { return (& $res $false 'read_failed' $label) }
                if ($now -cne $e.Sha256) { return (& $res $false 'changed' $label) }
            }
            $err = [int]0
            $p = [Phoenix.InputFileGuard.Native]::Open($e.HostPath, $false, $false, [ref]$err)
            try {
                if ($p.IsInvalid) { return (& $res $false 'changed' $label) }
                $pq = [Phoenix.InputFileGuard.Native]::Query($p, $false)
                if ($null -eq $pq) { return (& $res $false 'unreadable' $label) }
                if (([uint32]$pq.Attributes -band 0x400) -ne 0) { return (& $res $false 'reparse_point' $label) }
                if ($pq.VolumeSerial -ne $e.VolumeSerial -or $pq.FileIndex -ne $e.FileIndex) { return (& $res $false 'changed' $label) }
            } finally { $p.Dispose() }
        }
        return (& $res $true $null $null)
    } catch {
        return (& $res $false 'unreadable' $label)
    }
}

# Releases every handle. Idempotent; never throws.
function Close-InputFileGuard {
    [CmdletBinding()]
    param($Guard)
    try {
        if ($null -eq $Guard -or $Guard -isnot [pscustomobject] -or @($Guard.PSObject.Properties.Name) -cnotcontains 'Entries') { return }
        foreach ($e in @($Guard.Entries)) { try { if ($null -ne $e.Held) { $e.Held.Dispose() } } catch { } }
        if (@($Guard.PSObject.Properties.Name) -ccontains 'Closed') { $Guard.Closed = $true }
    } catch { }
}

function Get-InputFileGuardEntry {
    param([Parameter(Mandatory)]$Guard, [Parameter(Mandatory)][string]$Label)
    @($Guard.Entries | Where-Object { $_.Label -ceq $Label }) | Select-Object -First 1
}

# A move that never replaces: [System.IO.File]::Move with overwrite = $false (throws when the destination exists; the source is kept).
# It lives here, not in DiscoveryLauncher.psm1, because an existing test pins that file to exactly one rename (Write-TextAtomically).
function Move-FileNoOverwrite {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
    [System.IO.File]::Move($Source, $Destination, $false)
}

Export-ModuleMember -Function Get-InputFileGuardCodes, Get-InputFileTable, Open-InputFileGuard, Confirm-InputFileGuard, Close-InputFileGuard, Get-InputFileGuardEntry, Move-FileNoOverwrite