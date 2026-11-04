// Windows-only trusted launcher. No shell command is parsed by the host.
// Each invocation receives a fresh zero-network-capability AppContainer SID.
// ACLs are changed through pinned handles with NtSetSecurityObject: unlike
// SetSecurityInfo/icacls this never propagates permissions through a junction.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class Launcher {
 [StructLayout(LayoutKind.Sequential)] struct SI { public int cb; public IntPtr reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,cb2; public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr sid,caps; public int count,reserved; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong read,write,other,readBytes,writeBytes,otherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [StructLayout(LayoutKind.Sequential)] struct INFO { public uint attrs; public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write; public uint volume,sizeHi,sizeLo,links,indexHi,indexLo; }
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref LIMIT limit,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr p,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attributes,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr h,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out INFO info);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,IntPtr value,int size,out int returned);
 [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr h,int type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("ntdll.dll")] static extern int NtSetSecurityObject(IntPtr handle,uint info,byte[] descriptor);
 static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 16 };
 static volatile bool cancel;
 static volatile string cancelReason = "";
 static void Check(bool value,string stage) { if(!value) { int code=Marshal.GetLastWin32Error(); throw new Win32Exception(code,stage+" Win32Error="+code); } }
 static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
 static string Text(IDictionary<string,object> data,string key) { object value; return data.TryGetValue(key,out value) ? Convert.ToString(value) : ""; }
 static string SidText(IntPtr sid) { IntPtr p; Check(ConvertSidToStringSid(sid,out p),"SID conversion"); try { return Marshal.PtrToStringUni(p); } finally { LocalFree(p); } }
 static string Physical(IntPtr h) { var p=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(h,p,(uint)p.Capacity,0); Check(n>0&&n<p.Capacity,"canonical handle path"); string s=p.ToString(); if(s.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase))throw new Exception("UNC workspaces are not supported"); return s.StartsWith("\\\\?\\") ? s.Substring(4).TrimEnd('\\') : s.TrimEnd('\\'); }
 static bool Inside(string root,string value) { return String.Equals(root,value,StringComparison.OrdinalIgnoreCase)||value.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase); }
 static IntPtr Open(string p,bool writable,bool pin) { SA sa=new SA(); sa.size=Marshal.SizeOf(typeof(SA)); IntPtr h=CreateFile(p,0x20000u|(writable?0x40000u:0u),pin?3u:7u,ref sa,3,0x02000000|0x00200000,IntPtr.Zero); Check(h!=new IntPtr(-1),"pin workspace object"); return h; }
 static INFO Information(IntPtr h) { INFO info; Check(GetFileInformationByHandle(h,out info),"workspace object identity"); return info; }
 static string ObjectIdentity(IntPtr handle) { INFO info=Information(handle);return info.volume.ToString(System.Globalization.CultureInfo.InvariantCulture)+":"+(((ulong)info.indexHi<<32)|info.indexLo).ToString(System.Globalization.CultureInfo.InvariantCulture); }
 static void Acl(IntPtr h,SecurityIdentifier sid,bool directory,bool grant,bool writable) {
   IntPtr owner,group,dacl,sacl,sd;
   uint error=GetSecurityInfo(h,1,4,out owner,out group,out dacl,out sacl,out sd);
   if(error!=0)throw new Win32Exception((int)error,"read object ACL");
   try {
     int length=checked((int)GetSecurityDescriptorLength(sd)); byte[] bytes=new byte[length]; Marshal.Copy(sd,bytes,0,length);
     var descriptor=new CommonSecurityDescriptor(directory,false,bytes,0);
     if(descriptor.DiscretionaryAcl==null)throw new Exception("Workspace has an unrestricted DACL");
     bool present=false;foreach(GenericAce ace in descriptor.DiscretionaryAcl){var known=ace as KnownAce;if(known!=null&&known.SecurityIdentifier==sid)present=true;}
     if(!grant&&!present)return;
     descriptor.DiscretionaryAcl.Purge(sid);
     if(grant) descriptor.DiscretionaryAcl.AddAccess(AccessControlType.Allow,sid,(int)((writable?FileSystemRights.Modify:FileSystemRights.ReadAndExecute)|FileSystemRights.Synchronize),directory?InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit:InheritanceFlags.None,PropagationFlags.None);
     bytes=new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes,0);
     int status=NtSetSecurityObject(h,4,bytes);
     if(status!=0)throw new Exception("NtSetSecurityObject NTSTATUS=0x"+status.ToString("X8"));
   } finally { LocalFree(sd); }
 }
 class Grant { public IntPtr handle; public bool directory; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STREAM { public long size;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=296)]public string name; }
 [DllImport("kernel32.dll",EntryPoint="FindFirstStreamW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstStream(string file,int level,out STREAM stream,uint flags);
 [DllImport("kernel32.dll",EntryPoint="FindNextStreamW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextStream(IntPtr find,out STREAM stream);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr find);
 static void CheckStreams(string file) {
   STREAM stream;IntPtr find=FindFirstStream(file,0,out stream,0);
   if(find==new IntPtr(-1)){int error=Marshal.GetLastWin32Error();if(error==38)return;throw new Win32Exception(error,"Cannot verify workspace data streams");}
   try { while(true){if(stream.name!="::$DATA")throw new Exception("Alternate workspace data streams require explicit host execution");if(!FindNextStream(find,out stream)){int error=Marshal.GetLastWin32Error();if(error==38)break;throw new Win32Exception(error,"Cannot enumerate workspace data streams");}} }
   finally { FindClose(find); }
 }
 static void Walk(string root,string p,SecurityIdentifier sid,bool grant,bool writable,List<Grant> touched) {
   if(grant&&cancel)throw new Exception("Cancelled during isolation setup");
   if(touched.Count>=65536)throw new Exception("Workspace exceeds the 65536 object isolation budget");
   IntPtr h=Open(p,true,false); bool keep=false;
   try {
     INFO info=Information(h);
     if((info.attrs&0x400)!=0){if(grant)throw new Exception("Workspace reparse points require explicit host execution");return;} // Never follow or change a reparse point.
     if(!Inside(root,Physical(h)))throw new Exception("Workspace changed during isolation setup");
     bool directory=(info.attrs&16)!=0;
     if(grant&&!directory)CheckStreams(p);
      if(grant&&!directory&&info.links>1)throw new Exception("Hard-linked workspace files require explicit host execution");
     Acl(h,sid,directory,grant,writable); touched.Add(new Grant { handle=h,directory=directory }); keep=true;
     if(directory)foreach(string child in Directory.GetFileSystemEntries(p))Walk(root,child,sid,grant,writable,touched);
   } finally { if(!keep)CloseHandle(h); }
 }
 static void RemoveCurrent(string root,SecurityIdentifier sid) { var list=new List<Grant>(); try { Walk(root,root,sid,false,false,list); } finally { foreach(Grant g in list)CloseHandle(g.handle); } }
 static string Q(string s) { return "'"+s.Replace("'","''")+"'"; }
 static string Script(string root,string cwd,string temp,string command) {
   string relative=cwd.Substring(root.Length).TrimStart('\\');
   // PS providers do not always enumerate physical drives in an AppContainer.
   // A rooted PSDrive fixes provider operations; native cwd remains physical.
   return "$ProgressPreference='SilentlyContinue';try{$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$OutputEncoding=[Console]::OutputEncoding;"+
     "$env:TEMP="+Q(temp)+";$env:TMP="+Q(temp)+";$env:USERPROFILE="+Q(temp)+";$env:APPDATA="+Q(temp)+";$env:LOCALAPPDATA="+Q(temp)+";"+
     "$null=New-PSDrive -Name CodexWorkspace -PSProvider FileSystem -Root "+Q(root)+" -Scope Global;Set-Location -LiteralPath "+Q("CodexWorkspace:\\"+relative)+";"+
     "[System.IO.Directory]::SetCurrentDirectory("+Q(cwd)+");$global:LASTEXITCODE=0;& {\n"+command+"\n};if(!$?){exit 1};exit $global:LASTEXITCODE;}catch{[Console]::Error.WriteLine($_.Exception.Message);[Console]::Error.Flush();exit 1;}";
 }
 static IntPtr EnvironmentBlock(IDictionary<string,object> request,string temp) {
   string system=System.Environment.GetFolderPath(System.Environment.SpecialFolder.System),windows=Directory.GetParent(system).FullName;
   var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
   object raw;
   if(request.TryGetValue("env",out raw)) {
     var custom=raw as IDictionary<string,object>;
     if(custom==null)throw new Exception("Invalid environment map");
     foreach(var entry in custom) {
       string k=entry.Key;
       if(!System.Text.RegularExpressions.Regex.IsMatch(k,"^[A-Za-z_][A-Za-z0-9_()]{0,127}$"))throw new Exception("Invalid environment name");
       if(System.Text.RegularExpressions.Regex.IsMatch(k,"(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)|^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|NODE_OPTIONS|NODE_PATH|PYTHONPATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|PSMODULEPATH)$",System.Text.RegularExpressions.RegexOptions.IgnoreCase))continue;
       string v=Convert.ToString(entry.Value); if(v.IndexOf('\0')>=0||v.Length>8192)throw new Exception("Invalid environment value"); env[k]=v;
     }
   }
   env["SystemRoot"]=windows;env["WINDIR"]=windows;env["SystemDrive"]=Path.GetPathRoot(windows).TrimEnd('\\');env["ComSpec"]=Path.Combine(system,"cmd.exe");env["PATH"]=system;env["PATHEXT"]=".COM;.EXE;.BAT;.CMD";env["USERPROFILE"]=temp;env["APPDATA"]=temp;env["LOCALAPPDATA"]=temp;env["TEMP"]=temp;env["TMP"]=temp;
   var entries=new List<string>();foreach(var e in env)entries.Add(e.Key+"="+e.Value);
   return Marshal.StringToHGlobalUni(String.Join("\0",entries.ToArray())+"\0\0");
 }
 class Output {
   public readonly MemoryStream bytes=new MemoryStream(); public bool truncated; public Thread thread;
   public Output(IntPtr handle) {
     thread=new Thread(delegate() { try { using(var stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,4096,false)) { byte[] chunk=new byte[4096]; int n; while((n=stream.Read(chunk,0,chunk.Length))>0) { int keep=Math.Min(n,20000-(int)bytes.Length); if(keep>0)bytes.Write(chunk,0,keep); if(keep<n)truncated=true; } } }catch(IOException){} }); thread.IsBackground=true;thread.Start();
   }
   public string Base64() { return Convert.ToBase64String(bytes.ToArray()); }
 }
 [StructLayout(LayoutKind.Sequential)] struct GENERIC { public uint read,write,execute,all; }
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(byte[] descriptor,IntPtr token,uint desired,ref GENERIC mapping,IntPtr privileges,ref uint length,out uint granted,out bool allowed);
 static bool PackageAccess(IntPtr token,string packageSid) {
   var everyone=new SecurityIdentifier("S-1-1-0");var package=new SecurityIdentifier(packageSid);
   var acl=new DiscretionaryAcl(false,false,2);
   acl.AddAccess(AccessControlType.Allow,everyone,1,InheritanceFlags.None,PropagationFlags.None);
   acl.AddAccess(AccessControlType.Allow,package,1,InheritanceFlags.None,PropagationFlags.None);
   var descriptor=new CommonSecurityDescriptor(false,false,ControlFlags.DiscretionaryAclPresent,everyone,everyone,null,acl);
   byte[] bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
   IntPtr privileges=Marshal.AllocHGlobal(1024);uint length=1024,granted;bool allowed;GENERIC mapping=new GENERIC();mapping.read=1;mapping.write=2;mapping.execute=4;mapping.all=7;
   try { Check(AccessCheck(bytes,token,1,ref mapping,privileges,ref length,out granted,out allowed),"LPAC semantic access check");return allowed&&(granted&1)!=0; }
   finally { Marshal.FreeHGlobal(privileges); }
 }
 static void VerifyRestrictedPackageAccess(IntPtr token) {
   IntPtr duplicate;Check(DuplicateToken(token,2,out duplicate),"duplicate child token for LPAC access check");
   try { if(PackageAccess(duplicate,"S-1-15-2-1")||!PackageAccess(duplicate,"S-1-15-2-2"))throw new Exception("LPAC access semantics were not verified"); }
   finally { CloseHandle(duplicate); }
 }
 [DllImport("KernelBase.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name,out IntPtr groups,out uint groupCount,out IntPtr capabilities,out uint capabilityCount);
 static readonly List<IntPtr> capabilityAllocations=new List<IntPtr>();
 static readonly List<string> runtimeCapabilitySids=new List<string>();
 static IntPtr capabilityEntries=IntPtr.Zero;
 static CAPS RuntimeCapabilities(IntPtr appSid) {
   string[] names={"registryRead","lpacCom","lpacInstrumentation"};capabilityEntries=Marshal.AllocHGlobal(16*names.Length);
   for(int index=0;index<names.Length;index++) {
     IntPtr groups=IntPtr.Zero,capabilities=IntPtr.Zero;uint groupCount=0,count=0;
     try {
       Check(DeriveCapabilitySidsFromName(names[index],out groups,out groupCount,out capabilities,out count),"derive fixed runtime capability");
       if(count!=1)throw new Exception("Unexpected runtime capability count");
       IntPtr capability=Marshal.ReadIntPtr(capabilities);capabilityAllocations.Add(capability);runtimeCapabilitySids.Add(SidText(capability));
       Marshal.WriteIntPtr(capabilityEntries,index*16,capability);Marshal.WriteInt32(capabilityEntries,index*16+8,4);
     } finally { if(groups!=IntPtr.Zero){for(int i=0;i<groupCount;i++)LocalFree(Marshal.ReadIntPtr(groups,i*IntPtr.Size));LocalFree(groups);}if(capabilities!=IntPtr.Zero)LocalFree(capabilities); }
   }
   CAPS result=new CAPS();result.sid=appSid;result.caps=capabilityEntries;result.count=names.Length;return result;
 }
 static void TokenCheck(IntPtr process) {
   IntPtr token;Check(OpenProcessToken(process,10,out token),"open suspended child token");
   try {
     IntPtr p=Marshal.AllocHGlobal(4096);
     try { int got;Check(GetTokenInformation(token,29,p,4,out got),"AppContainer token check"); if(Marshal.ReadInt32(p)!=1)throw new Exception("Child is not an AppContainer");
        VerifyRestrictedPackageAccess(token);
       Check(GetTokenInformation(token,30,p,4096,out got),"network capabilities check");if(Marshal.ReadInt32(p)!=runtimeCapabilitySids.Count)throw new Exception("Unexpected AppContainer capabilities");
        for(int i=0;i<runtimeCapabilitySids.Count;i++)if(!runtimeCapabilitySids.Contains(SidText(Marshal.ReadIntPtr(p,8+i*16))))throw new Exception("Unapproved runtime capability");
     }finally{Marshal.FreeHGlobal(p);}
   }finally{CloseHandle(token);}
 }
 static void Recover(string cache) {
   foreach(string file in Directory.GetFiles(cache,"*.json")) {
     FileStream lease=null;IntPtr sid=IntPtr.Zero,pin=IntPtr.Zero;
     try {
       try{lease=new FileStream(file,FileMode.Open,FileAccess.ReadWrite,FileShare.None);}catch(IOException){continue;}
       string text;using(var reader=new StreamReader(lease,Encoding.UTF8,true,4096,true))text=reader.ReadToEnd();
       var record=Json.Deserialize<Dictionary<string,object>>(text);string profile=Text(record,"profile"),root=Text(record,"root");
       if(!profile.StartsWith("CodexE3Exec.",StringComparison.Ordinal)||profile.Length!=44)throw new Exception("Invalid cleanup journal identity");
       Check(DeriveAppContainerSidFromAppContainerName(profile,out sid)>=0,"derive cleanup identity");
       if(SidText(sid)!=Text(record,"sid"))throw new Exception("Cleanup journal SID mismatch");
       if(Directory.Exists(root)){pin=Open(root,true,true);if(!String.Equals(Physical(pin),root,StringComparison.OrdinalIgnoreCase))throw new Exception("Cleanup root changed");RemoveCurrent(root,new SecurityIdentifier(SidText(sid)));}
       string privateRoot=Text(record,"temp");
        if(privateRoot!="") {
          privateRoot=Path.GetFullPath(privateRoot);
          if(!Inside(cache,privateRoot)||!Path.GetFileName(privateRoot).StartsWith("work-",StringComparison.Ordinal))throw new Exception("Invalid cleanup private directory");
          if(Directory.Exists(privateRoot)){IntPtr privatePin=Open(privateRoot,true,true);try{if(!String.Equals(Physical(privatePin),privateRoot,StringComparison.OrdinalIgnoreCase))throw new Exception("Cleanup private directory changed");RemoveCurrent(privateRoot,new SecurityIdentifier(SidText(sid)));}finally{CloseHandle(privatePin);}}
        }
        int hr=DeleteAppContainerProfile(profile);if(hr!=0&&hr!=unchecked((int)0x80070002))throw new Exception("Recover profile HRESULT=0x"+hr.ToString("X8"));
       lease.Dispose();lease=null;File.Delete(file);
     }finally{if(pin!=IntPtr.Zero)CloseHandle(pin);if(sid!=IntPtr.Zero)FreeSid(sid);if(lease!=null)lease.Dispose();}
   }
 }
 // Dedicated E5 byte modes return before all E3 execution/ACL/recovery state.
 static class AttachmentIO {
  const int SourceLimit=2*1024*1024, PackageLimit=4*1024*1024, CipherLimit=3*1024*1024, ProtocolLimit=4*1024*1024, TimeoutMs=30000, JsonNodes=65536;
  static readonly JavaScriptSerializer Serializer=new JavaScriptSerializer { MaxJsonLength=ProtocolLimit, RecursionLimit=8 };
  static readonly byte[] Magic=Encoding.ASCII.GetBytes("E5IO0001");
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr h,int cls,IntPtr data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr h,int cls,IntPtr data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct AttachmentIoStatus { public IntPtr status,information; }
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr h,out AttachmentIoStatus status,IntPtr data,uint size,int cls);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateDirectory(string p,IntPtr attrs);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetVolumeInformationByHandleW(IntPtr h,StringBuilder name,uint nameSize,out uint serial,out uint maxComponent,out uint flags,StringBuilder filesystem,uint filesystemSize);
  sealed class Denied:Exception { public string code; public Denied(string c){code=c;} }
  static void Require(bool value,string code){if(!value)throw new Denied(code);}
  static string Identity(INFO info){return info.volume.ToString(System.Globalization.CultureInfo.InvariantCulture)+":"+(((ulong)info.indexHi<<32)|info.indexLo).ToString(System.Globalization.CultureInfo.InvariantCulture);}
  static ulong Size(INFO info){return ((ulong)info.sizeHi<<32)|info.sizeLo;}
  static bool Equal(string a,string b){return String.Equals(a,b,StringComparison.OrdinalIgnoreCase);}
  static bool Under(string root,string p){return Equal(root,p)||p.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
  static string HandlePath(IntPtr h){string p=Physical(h);return p.Length==2&&p[1]==':'?p+"\\":p;}
  static bool Device(string name){return System.Text.RegularExpressions.Regex.IsMatch(name,@"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$",System.Text.RegularExpressions.RegexOptions.IgnoreCase);}
  static string Absolute(string p,bool directory){
   Require(p!=null&&p.Length>=3&&p.Length<=32768&&((p[0]>='a'&&p[0]<='z')||(p[0]>='A'&&p[0]<='Z'))&&p[1]==':'&&(p[2]=='\\'||p[2]=='/'),"ATTACHMENT_READ_DENIED");
   p=p.Replace('/','\\');string tail=p.Substring(3);if(directory&&tail.EndsWith("\\"))tail=tail.Substring(0,tail.Length-1);
   Require((directory||tail.Length>0)&&tail.IndexOf(':')<0,"ATTACHMENT_READ_DENIED");foreach(char ch in p)Require(ch>=32&&ch!=127,"ATTACHMENT_READ_DENIED");
   foreach(string part in tail.Length==0?new string[0]:tail.Split('\\'))Require(part.Length>0&&part!="."&&part!=".."&&!part.EndsWith(".")&&!part.EndsWith(" ")&&!Device(part),"ATTACHMENT_READ_DENIED");
   string canonical=p.Substring(0,1).ToUpperInvariant()+":\\"+tail;Require(Equal(Path.GetFullPath(canonical),canonical),"ATTACHMENT_READ_DENIED");return canonical;
  }
  static IntPtr OpenObject(string p,uint access,uint creation,uint extraFlags){SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));IntPtr h=CreateFile(p,access,1,ref sa,creation,0x02000000u|0x00200000u|extraFlags,IntPtr.Zero);if(h==new IntPtr(-1)){int e=Marshal.GetLastWin32Error();throw new Denied(e==2||e==3?"ATTACHMENT_MISSING":"ATTACHMENT_READ_DENIED");}return h;}
  sealed class Pin:IDisposable {
   public IntPtr handle;public string path,identity;public INFO before;public bool directory;
   public Pin(string p,uint access,uint creation,uint extra,bool dir){path=p;directory=dir;handle=OpenObject(p,access,creation,extra);try{before=Information(handle);identity=Identity(before);Validate();}catch{Dispose();throw;}}
   public void Validate(){INFO now=Information(handle);Require((now.attrs&0x400)==0&&((now.attrs&16)!=0)==directory,"ATTACHMENT_READ_DENIED");Require(Equal(HandlePath(handle),path),"ATTACHMENT_SOURCE_CHANGED");if(!directory)Require(now.links==1,"ATTACHMENT_READ_DENIED");}
   public void Verify(){Validate();INFO now=Information(handle);Require(Identity(now)==identity&&now.attrs==before.attrs&&now.creation.dwHighDateTime==before.creation.dwHighDateTime&&now.creation.dwLowDateTime==before.creation.dwLowDateTime,"ATTACHMENT_SOURCE_CHANGED");if(!directory)Require(now.sizeHi==before.sizeHi&&now.sizeLo==before.sizeLo&&now.write.dwHighDateTime==before.write.dwHighDateTime&&now.write.dwLowDateTime==before.write.dwLowDateTime&&now.links==before.links,"ATTACHMENT_SOURCE_CHANGED");}
   public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
  }
  sealed class Pins:IDisposable {
   public readonly List<Pin> values=new List<Pin>();int pathBudget;
   public void Add(string p){pathBudget=checked(pathBudget+p.Length*6+128);Require(pathBudget<=ProtocolLimit,"ATTACHMENT_READ_DENIED");values.Add(new Pin(p,0x80u,3,0,true));}
   public Pin Last {get{return values[values.Count-1];}}
   public object[] Ancestors(){var a=new object[values.Count];for(int i=0;i<a.Length;i++)a[i]=new {path=values[i].path,identity=values[i].identity};return a;}
   public Pin At(string p){foreach(Pin pin in values)if(Equal(pin.path,p))return pin;throw new Denied("ATTACHMENT_SOURCE_CHANGED");}
   public void Verify(){foreach(Pin p in values)p.Verify();}
   public void Dispose(){for(int i=values.Count-1;i>=0;i--)values[i].Dispose();}
  }
  static Pins PinTree(string directory){directory=Absolute(directory,true);var pins=new Pins();try{pins.Add(directory.Substring(0,3));string p=directory.Substring(0,3);foreach(string part in directory.Length==3?new string[0]:directory.Substring(3).Split('\\')){p=p.TrimEnd('\\')+"\\"+part;pins.Add(p);}return pins;}catch{pins.Dispose();throw;}}
  static void Expected(Pins pins,IDictionary<string,object> request,string root){string expected=Text(request,"rootIdentity");if(expected!="")Require(pins.At(root).identity==expected,"ATTACHMENT_SOURCE_CHANGED");object raw;if(request.TryGetValue("expectedAncestors",out raw)&&raw!=null){var entries=raw as System.Collections.IList;Require(entries!=null&&entries.Count<=pins.values.Count,"ATTACHMENT_SOURCE_CHANGED");for(int i=0;i<entries.Count;i++){var item=entries[i] as IDictionary<string,object>;Require(item!=null&&Equal(Text(item,"path"),pins.values[i].path)&&Text(item,"identity")==pins.values[i].identity,"ATTACHMENT_SOURCE_CHANGED");}}}
  static void Streams(IntPtr h){Streams(h,false);}
  static void Streams(IntPtr h,bool directory){IntPtr buffer=Marshal.AllocHGlobal(65536);try{Marshal.WriteInt32(buffer,0,0);Marshal.WriteInt32(buffer,4,0);bool ok=GetFileInformationByHandleEx(h,7,buffer,65536);if(!ok&&directory&&Marshal.GetLastWin32Error()==38)return;Require(ok,"ATTACHMENT_READ_DENIED");int offset=0;while(true){Require(offset>=0&&offset<=65512,"ATTACHMENT_READ_DENIED");int next=Marshal.ReadInt32(buffer,offset),length=Marshal.ReadInt32(buffer,offset+4);Require(length>=0&&length%2==0&&length<=65536-offset-24,"ATTACHMENT_READ_DENIED");if(directory&&next==0&&length==0)break;Require(Marshal.PtrToStringUni(new IntPtr(buffer.ToInt64()+offset+24),length/2)=="::$DATA","ATTACHMENT_READ_DENIED");if(next==0)break;Require(next>=24&&next<=65536-offset,"ATTACHMENT_READ_DENIED");offset+=next;}}finally{Marshal.FreeHGlobal(buffer);}}
  static void Protected(string source,string root,bool inspect,IDictionary<string,object> request){object raw;Require(request.TryGetValue("protectedPaths",out raw),"ATTACHMENT_READ_DENIED");var roots=raw as System.Collections.IList;Require(roots!=null&&roots.Count<=JsonNodes,"ATTACHMENT_READ_DENIED");foreach(object value in roots){string p=Absolute(value as string,true);Require(!Under(p,source)&&(!inspect||!Under(root,p)),"ATTACHMENT_READ_DENIED");IntPtr h=IntPtr.Zero;try{h=OpenObject(p,0x80u,3,0);INFO info=Information(h);Require((info.attrs&0x400)==0&&Equal(HandlePath(h),p)&&!Under(HandlePath(h),source),"ATTACHMENT_READ_DENIED");}catch(Denied e){if(e.code!="ATTACHMENT_MISSING")throw;}finally{if(h!=IntPtr.Zero)CloseHandle(h);}}}
  static int Integer(IDictionary<string,object> request,string key,int min,int max){object value;Require(request.TryGetValue(key,out value)&&value!=null,"ATTACHMENT_READ_DENIED");long result;Require(Int64.TryParse(Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture),out result)&&result>=min&&result<=max,"ATTACHMENT_READ_DENIED");return (int)result;}
  static byte[] Exact(Stream input,int size){byte[] bytes=new byte[size];int used=0;while(used<size){int n=input.Read(bytes,used,Math.Min(65536,size-used));Require(n>0,"ATTACHMENT_READ_DENIED");used+=n;}return bytes;}
  static void ScanJson(string text){int depth=0,nodes=0;bool quoted=false,escape=false;foreach(char c in text){if(quoted){if(escape)escape=false;else if(c=='\\')escape=true;else if(c=='"')quoted=false;continue;}if(c=='"'){quoted=true;nodes++;}else if(c=='{'||c=='['){depth++;nodes++;Require(depth<=8,"ATTACHMENT_READ_DENIED");}else if(c=='}'||c==']')depth--;else if(!Char.IsWhiteSpace(c)&&c!=','&&c!=':')nodes++;Require(depth>=0&&nodes<=JsonNodes,"ATTACHMENT_READ_DENIED");}Require(!quoted&&depth==0,"ATTACHMENT_READ_DENIED");}
  static Dictionary<string,object> Request(Stream input,string mode){byte[] length=Exact(input,4);int size=BitConverter.ToInt32(length,0);Require(size>0&&size<=ProtocolLimit,"ATTACHMENT_READ_DENIED");string text=new UTF8Encoding(false,true).GetString(Exact(input,size));ScanJson(text);var request=Serializer.Deserialize<Dictionary<string,object>>(text);Require(Text(request,"mode")==mode,"ATTACHMENT_READ_DENIED");var allowed=new HashSet<string>(new string[]{"mode","operation","root","path","rootIdentity","expectedIdentity","expectedAncestors","expectedDigest","protectedPaths","maxBytes","bodyLength","kind","locator","maxEntries","blobsIdentity","maxScanned","namePrefix"});foreach(string key in request.Keys)Require(allowed.Contains(key),"ATTACHMENT_READ_DENIED");return request;}
  static void Frame(Stream output,object metadata,byte[] bytes,int length){string text=Serializer.Serialize(metadata);byte[] meta=Encoding.UTF8.GetBytes(text);Require(meta.Length>0&&meta.Length<=ProtocolLimit,"ATTACHMENT_READ_DENIED");output.Write(Magic,0,Magic.Length);byte[] size=BitConverter.GetBytes(meta.Length);output.Write(size,0,4);size=BitConverter.GetBytes(length);output.Write(size,0,4);output.Write(meta,0,meta.Length);if(length>0)output.Write(bytes,0,length);output.Flush();}
  static string Hash(byte[] bytes,int length){using(var hash=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes,0,length)).Replace("-","").ToLowerInvariant();}
  static byte[] Read(Pin file,int maximum,out int length){file.Verify();Streams(file.handle);Require(Size(file.before)<=(ulong)maximum,"ATTACHMENT_FILE_LIMIT");byte[] buffer=new byte[checked(maximum+1)];length=0;using(var stream=new FileStream(new SafeFileHandle(file.handle,false),FileAccess.Read,65536,false)){while(length<buffer.Length){if(cancel)throw new Denied(cancelReason=="timeout"?"ATTACHMENT_CAPTURE_TIMEOUT":"ABORTED");int n=stream.Read(buffer,length,Math.Min(65536,buffer.Length-length));if(n==0)break;length+=n;}}Require(length<=maximum,"ATTACHMENT_FILE_LIMIT");Require((ulong)length==Size(file.before),"ATTACHMENT_SOURCE_CHANGED");file.Verify();Streams(file.handle);return buffer;}
  static bool SafeName(string name){if(String.IsNullOrEmpty(name)||name=="."||name==".."||name.EndsWith(".")||name.EndsWith(" ")||Device(name))return false;int points=0;for(int i=0;i<name.Length;i++){char c=name[i];if(c<32||c==127||c==':'||c=='/'||c=='\\')return false;if(Char.IsHighSurrogate(c)){if(i+1>=name.Length||!Char.IsLowSurrogate(name[++i]))return false;}else if(Char.IsLowSurrogate(c))return false;if(++points>255)return false;}return true;}
  static object ProjectEntries(Pins pins,Pin root,string directory,IDictionary<string,object> request){int maximum=Integer(request,"maxEntries",1,100),scannedMaximum=Integer(request,"maxScanned",1,512);string prefix=Text(request,"namePrefix");Require(prefix.Length<=510,"ATTACHMENT_READ_DENIED");foreach(char c in prefix)Require(c>=32&&c!=127&&c!=':'&&c!='/'&&c!='\\',"ATTACHMENT_READ_DENIED");var entries=new List<object>();bool truncated=false;int scanned=0;using(var listing=new Pin(directory,0x81u,3,0,true)){Require(listing.identity==pins.Last.identity,"ATTACHMENT_SOURCE_CHANGED");Streams(listing.handle,true);IntPtr data=Marshal.AllocHGlobal(65536);try{bool restart=true,done=false;while(!done){if(cancel)throw new Denied(cancelReason=="timeout"?"ATTACHMENT_CAPTURE_TIMEOUT":"ABORTED");bool ok=GetFileInformationByHandleEx(listing.handle,restart?11:10,data,65536);restart=false;if(!ok){Require(Marshal.GetLastWin32Error()==18,"ATTACHMENT_READ_DENIED");break;}int offset=0;while(true){Require(offset<=65432,"ATTACHMENT_READ_DENIED");int next=Marshal.ReadInt32(data,offset),nameLength=Marshal.ReadInt32(data,offset+60);Require(nameLength>0&&nameLength%2==0&&nameLength<=65536-offset-104,"ATTACHMENT_READ_DENIED");string name=Marshal.PtrToStringUni(new IntPtr(data.ToInt64()+offset+104),nameLength/2);if(name!="."&&name!=".."){scanned++;bool isDirectory=(Marshal.ReadInt32(data,offset+56)&16)!=0;bool safe=(Marshal.ReadInt32(data,offset+56)&0x400)==0&&SafeName(name)&&name.StartsWith(prefix,StringComparison.OrdinalIgnoreCase);if(safe){try{using(var entry=new Pin(directory.TrimEnd('\\')+"\\"+name,0x80u,3,0,isDirectory)){ulong listed=(ulong)Marshal.ReadInt64(data,offset+96);Require((((ulong)entry.before.indexHi<<32)|entry.before.indexLo)==listed,"ATTACHMENT_SOURCE_CHANGED");Streams(entry.handle,isDirectory);entry.Verify();entries.Add(new {name=name,isDirectory=isDirectory});}}catch(Denied){}catch(IOException){}}if(scanned>=scannedMaximum||entries.Count>=maximum){truncated=true;done=true;break;}}if(next==0)break;Require(next>=104&&next<=65536-offset,"ATTACHMENT_READ_DENIED");offset+=next;}}listing.Verify();pins.Verify();}finally{Marshal.FreeHGlobal(data);}}return new {version=1,mode="capture",operation="list",type="result",ok=true,cleanupComplete=true,physicalPath=directory,rootIdentity=root.identity,ancestors=pins.Ancestors(),entries=entries,truncated=truncated};}
  static object Capture(IDictionary<string,object> request,out byte[] bytes,out int length){bytes=null;length=0;string operation=Text(request,"operation"),root=Absolute(Text(request,"root"),true);Require(operation=="inspect"||operation=="read"||operation=="list","ATTACHMENT_READ_DENIED");string source=operation=="inspect"?root:Absolute(Text(request,"path"),operation=="list");Require(Under(root,source)&&(!Equal(root,source)||operation!="read"),"ATTACHMENT_READ_DENIED");Protected(source,root,operation!="read",request);using(Pins pins=PinTree(operation=="inspect"?root:operation=="list"?source:Path.GetDirectoryName(source))){Expected(pins,request,root);Pin rootPin=pins.At(root);if(operation=="list")return ProjectEntries(pins,rootPin,source,request);if(operation=="inspect"){pins.Verify();return new {version=1,mode="capture",operation=operation,type="result",ok=true,cleanupComplete=true,physicalPath=root,rootIdentity=rootPin.identity,ancestors=pins.Ancestors()};}using(var file=new Pin(source,0x80000000u,3,0,false)){string expected=Text(request,"expectedIdentity");if(expected!="")Require(file.identity==expected,"ATTACHMENT_SOURCE_CHANGED");int maximum=Integer(request,"maxBytes",0,SourceLimit);bytes=Read(file,maximum,out length);string hash=Hash(bytes,length);expected=Text(request,"expectedDigest");if(expected!="")Require(hash==expected,"ATTACHMENT_SOURCE_CHANGED");pins.Verify();file.Verify();Protected(HandlePath(file.handle),root,false,request);return new {version=1,mode="capture",operation=operation,type="result",ok=true,cleanupComplete=true,physicalPath=source,name=Path.GetFileName(source),identity=file.identity,rootIdentity=rootPin.identity,ancestors=pins.Ancestors(),rawDigest=hash,byteLength=length};}}}
  static void ControlledDirectory(string p){if(!CreateDirectory(p,IntPtr.Zero))Require(Marshal.GetLastWin32Error()==183,"ATTACHMENT_STORAGE_UNAVAILABLE");}
  static void Ntfs(Pin root){uint serial,maxComponent,flags;var name=new StringBuilder(64);var filesystem=new StringBuilder(64);Require(GetVolumeInformationByHandleW(root.handle,name,64,out serial,out maxComponent,out flags,filesystem,64)&&filesystem.ToString()=="NTFS","ATTACHMENT_STORAGE_UNAVAILABLE");}
  static bool Locator(string kind,string locator){return kind=="manifest"?locator=="manifest.enc.json":kind=="blob"?System.Text.RegularExpressions.Regex.IsMatch(locator,@"^[a-f0-9]{32}\.enc\.json$"):kind=="temporary"&&System.Text.RegularExpressions.Regex.IsMatch(locator,@"^\.stage-[a-f0-9]{32}\.enc\.json$");}
  static void Disposition(IntPtr h,bool delete){IntPtr p=Marshal.AllocHGlobal(4);try{Marshal.WriteInt32(p,delete?1:8);Require(SetFileInformationByHandle(h,delete?4:21,p,4),"ATTACHMENT_STORAGE_UNAVAILABLE");}finally{Marshal.FreeHGlobal(p);}}
  static void Rename(IntPtr h,IntPtr directory,string name,bool replace){byte[] text=Encoding.Unicode.GetBytes(name);IntPtr data=Marshal.AllocHGlobal(20+text.Length);try{for(int i=0;i<20;i++)Marshal.WriteByte(data,i,0);Marshal.WriteInt32(data,0,replace?1:0);Marshal.WriteIntPtr(data,8,directory);Marshal.WriteInt32(data,16,text.Length);Marshal.Copy(text,0,new IntPtr(data.ToInt64()+20),text.Length);AttachmentIoStatus io;Require(NtSetInformationFile(h,out io,data,(uint)(20+text.Length),10)>=0,"ATTACHMENT_STORAGE_UNAVAILABLE");}finally{Marshal.FreeHGlobal(data);}}
  static void Package(byte[] bytes){string text;try{text=new UTF8Encoding(false,true).GetString(bytes);}catch{throw new Denied("ATTACHMENT_CORRUPT");}ScanJson(text);var value=Serializer.Deserialize<Dictionary<string,object>>(text);Require(value.Count==3&&Text(value,"cipher")=="electron-safeStorage"&&Integer(value,"formatVersion",1,1)==1,"ATTACHMENT_CORRUPT");string payload=Text(value,"payload");Require(payload.Length%4==0&&payload.Length<=4*((CipherLimit+2)/3),"ATTACHMENT_CORRUPT");string alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";int padding=payload.EndsWith("==")?2:payload.EndsWith("=")?1:0;for(int i=0;i<payload.Length-padding;i++)Require(alphabet.IndexOf(payload[i])>=0,"ATTACHMENT_CORRUPT");for(int i=payload.Length-padding;i<payload.Length;i++)Require(payload[i]=='=',"ATTACHMENT_CORRUPT");Require(payload.Length/4*3-padding<=CipherLimit&&(padding!=2||(alphabet.IndexOf(payload[payload.Length-3])&15)==0)&&(padding!=1||(alphabet.IndexOf(payload[payload.Length-2])&3)==0),"ATTACHMENT_CORRUPT");}
  static void ValidateTarget(string target,string expected){try{using(var file=new Pin(target,0x80000000u,3,0,false)){Streams(file.handle);Require(expected!=""&&file.identity==expected,"ATTACHMENT_CORRUPT");file.Verify();}}catch(Denied e){if(e.code=="ATTACHMENT_MISSING"&&expected=="")return;throw;}}
  static void Entries(Pin directory,bool root,int maximum,List<object> entries,ref int visited){using(var listing=new Pin(directory.path,0x81u,3,0,true)){Require(listing.identity==directory.identity,"ATTACHMENT_SOURCE_CHANGED");IntPtr data=Marshal.AllocHGlobal(65536);try{bool restart=true;while(true){if(cancel)throw new Denied("ABORTED");bool ok=GetFileInformationByHandleEx(listing.handle,restart?11:10,data,65536);restart=false;if(!ok){Require(Marshal.GetLastWin32Error()==18,"ATTACHMENT_READ_DENIED");break;}int offset=0;while(true){Require(offset<=65432,"ATTACHMENT_READ_DENIED");int next=Marshal.ReadInt32(data,offset),nameLength=Marshal.ReadInt32(data,offset+60);Require(nameLength>0&&nameLength%2==0&&nameLength<=65536-offset-104,"ATTACHMENT_READ_DENIED");string name=Marshal.PtrToStringUni(new IntPtr(data.ToInt64()+offset+104),nameLength/2);if(name!="."&&name!=".."){visited++;Require(visited<=maximum+1,"ATTACHMENT_CACHE_LIMIT");string kind=root?"manifest":name.StartsWith(".stage-",StringComparison.Ordinal)?"temporary":"blob";if(Locator(kind,name)){Require(entries.Count<maximum,"ATTACHMENT_CACHE_LIMIT");using(var file=new Pin(directory.path.TrimEnd('\\')+"\\"+name,0x80000000u,3,0,false)){Streams(file.handle);ulong listed=(ulong)Marshal.ReadInt64(data,offset+96);Require((((ulong)file.before.indexHi<<32)|file.before.indexLo)==listed,"ATTACHMENT_SOURCE_CHANGED");file.Verify();entries.Add(new {kind=kind,locator=name,identity=file.identity,size=Size(file.before)});}}}if(next==0)break;Require(next>=104&&next<=65536-offset,"ATTACHMENT_READ_DENIED");offset+=next;}}listing.Verify();}finally{Marshal.FreeHGlobal(data);}}}
  static object Managed(IDictionary<string,object> request,Stream input,Stream output,out byte[] bytes,out int length){
   bytes=null;length=0;string operation=Text(request,"operation"),root=Absolute(Text(request,"root"),true);Require(Path.GetFileName(root)=="attachments-v1","ATTACHMENT_STORAGE_UNAVAILABLE");
   if(operation=="scope"){string blobsIdentity;using(Pins parent=PinTree(Path.GetDirectoryName(root))){ControlledDirectory(root);using(Pin scope=new Pin(root,0x80u,3,0,true)){Ntfs(scope);ControlledDirectory(root+"\\blobs");using(Pin blobs=new Pin(root+"\\blobs",0x80u,3,0,true)){blobs.Verify();blobsIdentity=blobs.identity;}scope.Verify();parent.Verify();}}using(Pins pins=PinTree(root)){pins.Verify();return new {version=1,mode="managed",operation=operation,type="result",ok=true,cleanupComplete=true,physicalPath=root,rootIdentity=pins.Last.identity,ancestors=pins.Ancestors(),blobsIdentity=blobsIdentity,durableAtomic=true};}}
   Require(operation=="read"||operation=="write"||operation=="delete"||operation=="list","ATTACHMENT_STORAGE_UNAVAILABLE");using(Pins pins=PinTree(root)){Expected(pins,request,root);Ntfs(pins.Last);using(Pin blobs=new Pin(root+"\\blobs",0x80u,3,0,true)){
    Require(Text(request,"blobsIdentity")==blobs.identity,"ATTACHMENT_SOURCE_CHANGED");
    if(operation=="list"){int listMaximum=Integer(request,"maxEntries",1,JsonNodes);var entries=new List<object>();int visited=0;Entries(pins.Last,true,listMaximum,entries,ref visited);Entries(blobs,false,listMaximum,entries,ref visited);pins.Verify();blobs.Verify();return new {version=1,mode="managed",operation=operation,type="result",ok=true,cleanupComplete=true,entries=entries};}
    string kind=Text(request,"kind"),locator=Text(request,"locator"),expected=Text(request,"expectedIdentity");Require(Locator(kind,locator),"ATTACHMENT_STORAGE_UNAVAILABLE");Pin directory=kind=="manifest"?pins.Last:blobs;string target=directory.path.TrimEnd('\\')+"\\"+locator;int maximum=Integer(request,"maxBytes",0,PackageLimit);
    if(operation=="read"||operation=="delete"){Require(operation!="delete"||expected!="","ATTACHMENT_CORRUPT");using(Pin file=new Pin(target,0x80000000u|(operation=="delete"?0x10000u:0u),3,0,false)){if(expected!="")Require(file.identity==expected,"ATTACHMENT_CORRUPT");Streams(file.handle);file.Verify();pins.Verify();blobs.Verify();string id=file.identity;if(operation=="read"){bytes=Read(file,maximum,out length);pins.Verify();blobs.Verify();return new {version=1,mode="managed",operation=operation,type="result",ok=true,cleanupComplete=true,identity=id,rawDigest=Hash(bytes,length),byteLength=length};}Disposition(file.handle,true);return new {version=1,mode="managed",operation=operation,type="result",ok=true,cleanupComplete=true,identity=id};}}
    Require(kind!="temporary","ATTACHMENT_STORAGE_UNAVAILABLE");int bodyLength=Integer(request,"bodyLength",0,maximum);byte[] cipher=Exact(input,bodyLength);Package(cipher);ValidateTarget(target,expected);string stage=blobs.path+"\\.stage-"+Guid.NewGuid().ToString("N")+".enc.json";
    using(Pin file=new Pin(stage,0xc0010000u,1,0x04000100u,false)){bool committed=false;try{using(var stream=new FileStream(new SafeFileHandle(file.handle,false),FileAccess.ReadWrite,65536,false)){stream.Write(cipher,0,cipher.Length);stream.Flush(true);stream.Position=0;file.before=Information(file.handle);int actual;byte[] captured=Read(file,maximum,out actual);Require(actual==cipher.Length&&Hash(captured,actual)==Hash(cipher,cipher.Length),"ATTACHMENT_CORRUPT");pins.Verify();blobs.Verify();Frame(output,new {version=1,mode="managed",operation=operation,type="staged",ok=true,identity=file.identity,rawDigest=Hash(captured,actual)},captured,actual);}
     int command=input.ReadByte();Require(command==1&&!cancel,cancelReason=="timeout"?"ATTACHMENT_CAPTURE_TIMEOUT":"ABORTED");pins.Verify();blobs.Verify();file.Verify();Streams(file.handle);ValidateTarget(target,expected);Disposition(file.handle,false);Rename(file.handle,directory.handle,locator,expected!="");file.path=target;file.Verify();Require(FlushFileBuffers(file.handle),"ATTACHMENT_STORAGE_UNAVAILABLE");pins.Verify();blobs.Verify();committed=true;return new {version=1,mode="managed",operation=operation,type="result",ok=true,cleanupComplete=true,identity=file.identity};
    }finally{if(!committed)try{Disposition(file.handle,true);}catch{}}}
   }}
  }
  public static int Run(string mode,bool probe){Stream output=Console.OpenStandardOutput();if(probe){Frame(output,new {version=1,mode=mode,operation="probe",type="result",ok=true,cleanupComplete=true,sourceMaxBytes=SourceLimit,managedMaxBytes=PackageLimit,timeoutMs=TimeoutMs,captureProtocol=1,sourceReadAccess="GENERIC_READ",sourceShare="READ",sourceWrites=false,managedAtomic=true},null,0);return 0;}
   string operation="";object result=null;byte[] bytes=null;int length=0;Timer timer=null;
   try{Stream input=Console.OpenStandardInput();var request=Request(input,mode);operation=Text(request,"operation");cancel=false;cancelReason="";timer=new Timer(delegate{cancelReason="timeout";cancel=true;},null,TimeoutMs,System.Threading.Timeout.Infinite);if(mode=="capture")result=Capture(request,out bytes,out length);else result=Managed(request,input,output,out bytes,out length);if(cancel)throw new Denied(cancelReason=="timeout"?"ATTACHMENT_CAPTURE_TIMEOUT":"ABORTED");}
   catch(Denied e){result=new {version=1,mode=mode,operation=operation,type="result",ok=false,cleanupComplete=true,code=mode=="capture"&&e.code=="ATTACHMENT_MISSING"?"ATTACHMENT_READ_DENIED":e.code};bytes=null;length=0;}
   catch{result=new {version=1,mode=mode,operation=operation,type="result",ok=false,cleanupComplete=true,code=mode=="managed"?"ATTACHMENT_STORAGE_UNAVAILABLE":"ATTACHMENT_READ_DENIED"};bytes=null;length=0;}
   finally{if(timer!=null)timer.Dispose();}Frame(output,result,bytes,length);return 0;
  }
 }
 static int Main(string[] args) {
   if(args.Length>0&&(args[0]=="--capture-file"||args[0]=="--managed-file")) {
    if(args.Length!=1&&(args.Length!=2||args[1]!="--probe"))return 1;
    return AttachmentIO.Run(args[0]=="--capture-file"?"capture":"managed",args.Length==2);
   }
   Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);
   if(args.Length==2&&args[0]=="--recover") { try { Recover(Path.GetFullPath(args[1]));Emit(new {type="recovered",ok=true});return 0;}catch(Exception e){Emit(new {type="recovered",ok=false,error=e.Message});return 1;} }
   IntPtr sid=IntPtr.Zero,pin=IntPtr.Zero,cwdPin=IntPtr.Zero,job=IntPtr.Zero,list=IntPtr.Zero,lpac=IntPtr.Zero,cap=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero;
   PI pi=new PI();Output stdout=null,stderr=null;var touched=new List<Grant>();FileStream journal=null;string journalPath="",profile="",root="",temp="",error="";bool created=false,verified=false,timedOut=false,cleanup=true;uint exit=125;SecurityIdentifier identity=null;
   try {
     string line=Console.ReadLine();if(line==null||line.Length>65536)throw new Exception("Missing or oversized launch request");
     var request=Json.Deserialize<Dictionary<string,object>>(line);
     var control=new Thread(delegate() { try{string message=Console.ReadLine();cancelReason=message=="timeout"?"timeout":"aborted";}catch{cancelReason="aborted";}cancel=true; });control.IsBackground=true;control.Start();
     root=Path.GetFullPath(Text(request,"root")).TrimEnd('\\');string cwd=Path.GetFullPath(Text(request,"cwd")).TrimEnd('\\');temp=Path.GetFullPath(Text(request,"temp"));string cache=Path.GetFullPath(Text(request,"cache"));
     if(!Inside(root,cwd)||!Inside(cache,temp)||String.Equals(cache,temp,StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid execution boundary");
     string command=Text(request,"command");if(String.IsNullOrWhiteSpace(command)||command.Length>16384||command.IndexOf('\0')>=0)throw new Exception("Invalid command");
     int timeout=Convert.ToInt32(request["timeoutMs"]);if(timeout<100||timeout>120000)throw new Exception("Invalid timeout");
     Directory.CreateDirectory(cache);Recover(cache);
     pin=Open(root,true,true);if(!String.Equals(root,Physical(pin),StringComparison.OrdinalIgnoreCase)||(Information(pin).attrs&0x400)!=0)throw new Exception("Non-canonical workspace root");
      cwdPin=Open(cwd,true,true);if(!String.Equals(cwd,Physical(cwdPin),StringComparison.OrdinalIgnoreCase)||(Information(cwdPin).attrs&0x400)!=0)throw new Exception("Non-canonical working directory");
      if(ObjectIdentity(pin)!=Text(request,"rootObject")||ObjectIdentity(cwdPin)!=Text(request,"cwdObject"))throw new Exception("Workspace object identity changed after confirmation");
     // Root pin excludes delete-sharing, preventing root/junction substitution.
     profile="CodexE3Exec."+Guid.NewGuid().ToString("N");
     int hr=DeriveAppContainerSidFromAppContainerName(profile,out sid);if(hr<0)throw new Exception("CreateAppContainerProfile HRESULT=0x"+hr.ToString("X8"));
     identity=new SecurityIdentifier(SidText(sid));journalPath=Path.Combine(cache,profile+".json");
     journal=new FileStream(journalPath,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read);
     byte[] record=Encoding.UTF8.GetBytes(Json.Serialize(new {profile=profile,sid=identity.Value,root=root,temp=temp}));journal.Write(record,0,record.Length);journal.Flush(true);
      IntPtr actualSid=IntPtr.Zero;
      try { hr=CreateAppContainerProfile(profile,profile,"Single-use Codex isolated command",IntPtr.Zero,0,out actualSid);if(hr<0)throw new Exception("CreateAppContainerProfile HRESULT=0x"+hr.ToString("X8"));created=true;if(SidText(actualSid)!=identity.Value)throw new Exception("Created AppContainer identity mismatch"); }
      finally { if(actualSid!=IntPtr.Zero)FreeSid(actualSid); }
     string workspacePolicy=Text(request,"policy");if(workspacePolicy!="read-only"&&workspacePolicy!="workspace-write")throw new Exception("Unsupported workspace policy");
      bool writable=workspacePolicy=="workspace-write";
     Walk(root,root,identity,true,writable,touched);Directory.CreateDirectory(temp);Walk(temp,temp,identity,true,true,touched);
     SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));sa.inherit=true;
     Check(CreatePipe(out outRead,out outWrite,ref sa,0),"stdout pipe");Check(SetHandleInformation(outRead,1,0),"stdout parent handle");
     Check(CreatePipe(out errRead,out errWrite,ref sa,0),"stderr pipe");Check(SetHandleInformation(errRead,1,0),"stderr parent handle");
     input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);Check(input!=new IntPtr(-1),"empty command stdin");
     IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref size);list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,3,0,ref size),"process attribute list");
     lpac=Marshal.AllocHGlobal(4);Marshal.WriteInt32(lpac,1);
      try { Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000f),lpac,new IntPtr(4),IntPtr.Zero,IntPtr.Zero),"LPAC opt out of broad application-package permissions"); }
      finally { /* lpac policy remains pinned until process creation */ }
      CAPS capabilities=RuntimeCapabilities(sid);cap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAPS)));Marshal.StructureToPtr(capabilities,cap,false);
     Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),cap,new IntPtr(Marshal.SizeOf(typeof(CAPS))),IntPtr.Zero,IntPtr.Zero),"zero-network AppContainer");
     handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite);Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);
     Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"explicit stdio handle whitelist");
     job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"job creation");LIMIT limit=new LIMIT();limit.basic.flags=0x2000|0x8|0x100|0x200;limit.basic.active=16;limit.processMemory=new UIntPtr(512u*1024u*1024u);limit.jobMemory=new UIntPtr(1024u*1024u*1024u);
     Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(LIMIT))),"job process/memory/kill-on-close limits");
     SIX six=new SIX();six.si.cb=Marshal.SizeOf(typeof(SIX));six.attrs=list;six.si.flags=0x100;six.si.input=input;six.si.output=outWrite;six.si.error=errWrite;
     string ps=Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.System),"WindowsPowerShell\\v1.0\\powershell.exe");
     string encoded=Convert.ToBase64String(Encoding.Unicode.GetBytes(Script(root,cwd,temp,command)));env=EnvironmentBlock(request,temp);
     Check(CreateProcess(ps,new StringBuilder("\""+ps+"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "+encoded),IntPtr.Zero,IntPtr.Zero,true,0x00080000|0x00000004|0x08000000|0x00000400,env,cwd,ref six,out pi),"suspended isolated PowerShell");
     Check(AssignProcessToJobObject(job,pi.process),"job assignment before execution");TokenCheck(pi.process);
     if(cancel)throw new Exception("Cancelled before execution");
     Check(ResumeThread(pi.thread)!=0xffffffff,"resume verified child");verified=true;
     CloseHandle(outWrite);outWrite=IntPtr.Zero;CloseHandle(errWrite);errWrite=IntPtr.Zero;CloseHandle(input);input=IntPtr.Zero;
     stdout=new Output(outRead);outRead=IntPtr.Zero;stderr=new Output(errRead);errRead=IntPtr.Zero;
     Emit(new {type="started",pid=pi.pid,profile=profile,isolated=true,executionMode="strict-isolated"});
     var clock=System.Diagnostics.Stopwatch.StartNew();
     while(true) { uint wait=WaitForSingleObject(pi.process,50);if(wait==0)break;if(wait!=258)throw new Exception("Process wait failed");if(cancel||clock.ElapsedMilliseconds>=timeout){timedOut=cancelReason=="timeout"||clock.ElapsedMilliseconds>=timeout;Check(TerminateJobObject(job,124),"cancel entire job");WaitForSingleObject(pi.process,5000);break;} }
     Check(GetExitCodeProcess(pi.process,out exit),"isolated exit code");
   } catch(Exception e) { error=e.Message; }
   finally {
     if(pi.process!=IntPtr.Zero)TerminateProcess(pi.process,125);
     if(job!=IntPtr.Zero){TerminateJobObject(job,125);if(WaitForSingleObject(job,5000)!=0){cleanup=false;error+="; job did not drain";}CloseHandle(job);}
     if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);
     foreach(IntPtr h in new IntPtr[]{outWrite,errWrite,input,outRead,errRead})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);
     if(stdout!=null&&!stdout.thread.Join(5000)){cleanup=false;error+="; stdout did not drain";}if(stderr!=null&&!stderr.thread.Join(5000)){cleanup=false;error+="; stderr did not drain";}
     if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}foreach(IntPtr p in new IntPtr[]{cap,handles,env,lpac})if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);
     foreach(IntPtr capability in capabilityAllocations)LocalFree(capability);if(capabilityEntries!=IntPtr.Zero)Marshal.FreeHGlobal(capabilityEntries);
      if(identity!=null) {
       foreach(Grant g in touched)try{Acl(g.handle,identity,g.directory,false,false);}catch(Exception e){cleanup=false;error+="; ACL cleanup: "+e.Message;}
       try{if(root!=""&&Directory.Exists(root))RemoveCurrent(root,identity);if(temp!=""&&Directory.Exists(temp))RemoveCurrent(temp,identity);}catch(Exception e){cleanup=false;error+="; new-object ACL cleanup: "+e.Message;}
     }
     foreach(Grant g in touched)CloseHandle(g.handle);if(cwdPin!=IntPtr.Zero)CloseHandle(cwdPin);if(pin!=IntPtr.Zero)CloseHandle(pin);if(sid!=IntPtr.Zero)FreeSid(sid);
     if(created){int hr=DeleteAppContainerProfile(profile);if(hr!=0){cleanup=false;error+="; profile cleanup HRESULT=0x"+hr.ToString("X8");}}
     if(journal!=null)journal.Dispose();if(cleanup&&journalPath!="")try{File.Delete(journalPath);}catch(Exception e){cleanup=false;error+="; journal cleanup: "+e.Message;}
   }
   Emit(new {type="result",ok=verified&&error==""&&exit==0&&!cancel&&!timedOut&&cleanup,isolated=verified,executionMode=verified?"strict-isolated":"not-started",exitCode=(int)exit,timedOut=timedOut,aborted=cancel&&!timedOut,stdoutBase64=stdout==null?"":stdout.Base64(),stderrBase64=stderr==null?"":stderr.Base64(),outputTruncated=(stdout!=null&&stdout.truncated)||(stderr!=null&&stderr.truncated),cleanupComplete=cleanup,profileDeleted=created&&cleanup,profile=profile,error=error});
   return cleanup&&error==""?0:1;
 }
}
