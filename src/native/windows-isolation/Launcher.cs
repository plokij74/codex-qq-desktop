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
 static int Main(string[] args) {
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
