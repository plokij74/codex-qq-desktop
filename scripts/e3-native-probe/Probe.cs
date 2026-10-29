using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Net;
using System.Net.Sockets;

class Probe {
 [StructLayout(LayoutKind.Sequential)] struct SI { public int cb; public IntPtr reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,cb2; public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr sid,caps; public int count,reserved; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong read,write,other,readBytes,writeBytes,otherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
 [DllImport("advapi32.dll",SetLastError=true)] static extern IntPtr FreeSid(IntPtr sid);
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
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,out int value,int size,out int returned);
 static void Check(bool ok,string stage) { if(!ok) { int code=Marshal.GetLastWin32Error(); throw new Win32Exception(code,stage+" Win32Error="+code); } }
 static string Q(string s){return "\""+s+"\"";}
 static void Grant(string path,string sid,string rights) {
  var p=Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"icacls.exe"),Q(path)+" /grant "+Q("*"+sid+":"+rights)){UseShellExecute=false,CreateNoWindow=true}); p.WaitForExit(); if(p.ExitCode!=0)throw new Exception("ACL grant failed "+p.ExitCode);
 }
 static IntPtr MinimalEnvironment(string cwd) {
   string system=Environment.GetFolderPath(Environment.SpecialFolder.System);
   string windows=Directory.GetParent(system).FullName;
   string[] entries={"USERPROFILE="+cwd,"LOCALAPPDATA="+cwd,"APPDATA="+cwd,"SystemDrive="+Path.GetPathRoot(windows).TrimEnd('\\'),"ComSpec="+Path.Combine(system,"cmd.exe"),"PATH="+system,"PATHEXT=.COM;.EXE;.BAT;.CMD","SystemRoot="+windows,"TEMP="+cwd,"TMP="+cwd,"WINDIR="+windows};
   Array.Sort(entries,StringComparer.OrdinalIgnoreCase);
   return Marshal.StringToHGlobalUni(String.Join("\0",entries)+"\0\0");
  }
  static uint Run(string name,string exe,string args,string cwd,IntPtr sid) {
  IntPtr bytes=IntPtr.Zero,list=IntPtr.Zero,cap=IntPtr.Zero,job=IntPtr.Zero,environment=IntPtr.Zero; PI pi=new PI();
  try {
   InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes); list=Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(list,1,0,ref bytes),"attributes initialize");
   CAPS caps=new CAPS();caps.sid=sid;cap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAPS)));Marshal.StructureToPtr(caps,cap,false);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),cap,new IntPtr(Marshal.SizeOf(typeof(CAPS))),IntPtr.Zero,IntPtr.Zero),"security capabilities");
   job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"create job"); LIMIT lim=new LIMIT(); lim.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref lim,(uint)Marshal.SizeOf(typeof(LIMIT))),"job kill-on-close");
   SIX six=new SIX();six.si.cb=Marshal.SizeOf(typeof(SIX));six.attrs=list;
   environment=MinimalEnvironment(cwd);
    Check(CreateProcess(exe,new StringBuilder(Q(exe)+" "+args),IntPtr.Zero,IntPtr.Zero,false,0x00080000|0x00000004|0x08000000|0x00000400,environment,cwd,ref six,out pi),"CreateProcess "+name);
   Check(AssignProcessToJobObject(job,pi.process),"assign suspended process to job");
   IntPtr token;Check(OpenProcessToken(pi.process,8,out token),"open child token");try{int isAC,got;Check(GetTokenInformation(token,29,out isAC,4,out got),"query AppContainer token");Console.WriteLine(name+" pid="+pi.pid+" TokenIsAppContainer="+isAC);if(isAC!=1)throw new Exception("Not AppContainer");}finally{CloseHandle(token);}
   if(ResumeThread(pi.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error(),"resume");
   uint wait=WaitForSingleObject(pi.process,15000); if(wait!=0)throw new Exception(name+" timed out or wait failed: "+wait); uint code;Check(GetExitCodeProcess(pi.process,out code),"exit code");Console.WriteLine(name+" exit="+code);return code;
  }
  finally {if(pi.process!=IntPtr.Zero){TerminateProcess(pi.process,125);}if(job!=IntPtr.Zero){CloseHandle(job);}if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(cap!=IntPtr.Zero)Marshal.FreeHGlobal(cap);}
 }
 static void Child(string workspace,string outside,int port) {
  string report="managed child started\r\n";
   report+="env-clean="+(Environment.GetEnvironmentVariable("E3_PROBE_SECRET")==null&&Environment.GetEnvironmentVariable("E3_PROBE_ORDINARY")==null?"OK":"FAIL")+"\r\n";
   report+="temp-path="+Environment.GetEnvironmentVariable("TEMP")+"\r\ntmp-path="+Environment.GetEnvironmentVariable("TMP")+"\r\n";
   string temp=Environment.GetEnvironmentVariable("TEMP"),tmp=Environment.GetEnvironmentVariable("TMP");
   bool privateTemp=!String.IsNullOrEmpty(temp)&&!String.IsNullOrEmpty(tmp)&&Path.GetFullPath(temp).StartsWith(workspace+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)&&String.Equals(temp,tmp,StringComparison.OrdinalIgnoreCase);
   report+="temp-private="+(privateTemp?"OK":"FAIL")+"\r\n";
  try{File.WriteAllText(Path.Combine(workspace,"managed-allowed.txt"),"allowed");report+="inside-write=OK\r\n";}catch(Exception e){report+="inside-write="+e.GetType().Name+"\r\n";}
  try{File.ReadAllText(outside);report+="outside-read=UNEXPECTED_ALLOWED\r\n";}catch(Exception e){report+="outside-read="+e.GetType().Name+"\r\n";}
  try{File.WriteAllText(outside,"changed");report+="outside-write=UNEXPECTED_ALLOWED\r\n";}catch(Exception e){report+="outside-write="+e.GetType().Name+"\r\n";}
  try{using(var c=new TcpClient()){var a=c.BeginConnect(IPAddress.Loopback,port,null,null);if(!a.AsyncWaitHandle.WaitOne(2000))throw new TimeoutException();c.EndConnect(a);report+="loopback=UNEXPECTED_CONNECTED\r\n";}}catch(SocketException e){report+="loopback=SocketException:"+e.SocketErrorCode+"\r\n";}catch(Exception e){report+="loopback="+e.GetType().Name+" "+e.Message+"\r\n";}
  File.WriteAllText(Path.Combine(workspace,"managed-report.txt"),report);
 }
  static int failures;
  static void Assert(string name,bool ok) {
    Console.WriteLine("CHECK "+name+"="+(ok?"PASS":"FAIL")); if(!ok)failures++;
  }
  static int Main(string[] args) {
    if(args.Length>0&&args[0]=="--linger") {
      File.WriteAllText(Path.Combine(args[1],"descendant-pid.txt"),Process.GetCurrentProcess().Id.ToString());
      System.Threading.Thread.Sleep(30000);return 0;
    }
    if(args.Length>0&&args[0]=="--spawn-descendant") {
      using(var child=Process.Start(new ProcessStartInfo(typeof(Probe).Assembly.Location,"--linger "+Q(args[1])){UseShellExecute=false,CreateNoWindow=true})) {
        for(int i=0;i<50&&!File.Exists(Path.Combine(args[1],"descendant-pid.txt"));i++)System.Threading.Thread.Sleep(50);
        return File.Exists(Path.Combine(args[1],"descendant-pid.txt"))?0:1;
      }
    }
    if(args.Length>0&&args[0]=="--child"){Child(args[1],args[2],int.Parse(args[3]));return 0;}
    if(args.Length!=3){Console.Error.WriteLine("Pass provider fixture, Node executable and Node fixture paths.");return 2;}
    // Always allocate a fresh root; never grant ACLs on the source tree or supplied fixture path.
    string root=Path.Combine(Path.GetTempPath(),"codex-e3-native-"+Guid.NewGuid().ToString("N"));
    string work=Path.Combine(root,"workspace"),outside=Path.Combine(root,"outside-canary.txt"),payload=Path.Combine(root,"payload.exe");
    string profile="CodexE3Probe."+Guid.NewGuid().ToString("N");
    IntPtr sid=IntPtr.Zero;TcpListener listener=null;bool created=false;
    Console.WriteLine("EVIDENCE "+root);
    try {
      Environment.SetEnvironmentVariable("E3_PROBE_SECRET","synthetic-canary-only");
      Environment.SetEnvironmentVariable("E3_PROBE_ORDINARY","synthetic-ordinary-only");
      Assert("host-env-positive",Environment.GetEnvironmentVariable("E3_PROBE_SECRET")!=null&&Environment.GetEnvironmentVariable("E3_PROBE_ORDINARY")!=null);
      Directory.CreateDirectory(work);
      File.Copy(typeof(Probe).Assembly.Location,payload);
      File.Copy(args[0],Path.Combine(work,"provider.ps1"));
      string node=Path.Combine(root,"node.exe");
      File.Copy(args[1],node);
      File.Copy(args[2],Path.Combine(work,"node-fixture.cjs"));
      File.WriteAllText(outside,"outside-original");
      string external=Path.Combine(root,"external"),junction=Path.Combine(work,"escape");
      Directory.CreateDirectory(external);
      File.WriteAllText(Path.Combine(external,"canary.txt"),"junction-original");
      using(var mklink=Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe"),"/d /c mklink /J "+Q(junction)+" "+Q(external)){UseShellExecute=false,CreateNoWindow=true})) {
        if(!mklink.WaitForExit(10000)||mklink.ExitCode!=0)throw new Exception("Junction fixture creation failed");
      }
      Assert("junction-host-positive",File.ReadAllText(Path.Combine(junction,"canary.txt"))=="junction-original");
      int hr=CreateAppContainerProfile(profile,profile,"Disposable E3 regression probe",IntPtr.Zero,0,out sid);
      if(hr<0)throw new Exception("CreateAppContainerProfile HRESULT=0x"+hr.ToString("X8"));
      created=true;
      IntPtr sidText;Check(ConvertSidToStringSid(sid,out sidText),"sid conversion");
      string sidValue=Marshal.PtrToStringUni(sidText);LocalFree(sidText);
      Grant(root,sidValue,"RX");Grant(work,sidValue,"(OI)(CI)M");Grant(payload,sidValue,"RX");Grant(node,sidValue,"RX");
      Assert("node-exit",Run("node",node,Q(Path.Combine(work,"node-fixture.cjs"))+" "+Q(work)+" "+Q(outside),work,sid)==0);
      string[] nodeResults=File.ReadAllLines(Path.Combine(work,"node-results.txt"));
      foreach(string name in new string[]{"node-inside-io","node-env-clean","node-outside-read-denied","node-outside-write-denied","node-junction-read-denied","node-junction-write-denied"})
        Assert(name,Array.IndexOf(nodeResults,name+"=PASS")>=0&&Array.IndexOf(nodeResults,name+"=FAIL")<0);
      string ps=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell\\v1.0\\powershell.exe");
      Assert("provider-exit",Run("provider",ps,"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+Q(Path.Combine(work,"provider.ps1"))+" -Work "+Q(work)+" -Outside "+Q(outside),work,sid)==0);
      string[] provider=File.ReadAllLines(Path.Combine(work,"provider-results.txt"));
      foreach(string name in new string[]{"provider-bootstrap","native-nested-cwd","provider-outside-read-denied","provider-outside-write-denied","dotnet-outside-read-denied","dotnet-outside-write-denied","junction-provider-read-denied","junction-provider-write-denied","junction-dotnet-read-denied","junction-dotnet-write-denied"})
        Assert(name,Array.IndexOf(provider,name+"=PASS")>=0&&Array.IndexOf(provider,name+"=FAIL")<0);
      Assert("descendant-parent-exit",Run("descendant-parent",payload,"--spawn-descendant "+Q(work),work,sid)==0);
      int pid=int.Parse(File.ReadAllText(Path.Combine(work,"descendant-pid.txt")));
      bool gone=false;try{using(var proc=Process.GetProcessById(pid)){gone=proc.WaitForExit(5000);}}catch(ArgumentException){gone=true;}
      Assert("descendant-cleaned",gone);
      listener=new TcpListener(IPAddress.Loopback,0);listener.Start();int port=((IPEndPoint)listener.LocalEndpoint).Port;
      using(var control=new TcpClient()){control.Connect(IPAddress.Loopback,port);using(var accepted=listener.AcceptTcpClient()){} }
      Assert("host-loopback-positive",true);
      Assert("managed-exit",Run("managed",payload,"--child "+Q(work)+" "+Q(outside)+" "+port,work,sid)==0);
      string report=File.ReadAllText(Path.Combine(work,"managed-report.txt"));
      Assert("managed-env-clean",report.Contains("env-clean=OK"));
      Assert("managed-temp-private",report.Contains("temp-private=OK"));
      Assert("managed-inside-write",report.Contains("inside-write=OK"));
      Assert("managed-outside-read-denied",report.Contains("outside-read=UnauthorizedAccessException"));
      Assert("managed-outside-write-denied",report.Contains("outside-write=UnauthorizedAccessException"));
      Assert("loopback-denied",report.Contains("loopback=TimeoutException")||report.Contains("loopback=SocketException:AccessDenied"));
      Assert("outside-canary-unchanged",File.ReadAllText(outside)=="outside-original");
      Assert("junction-canary-unchanged",File.ReadAllText(Path.Combine(external,"canary.txt"))=="junction-original");
    }catch(Exception e){Console.Error.WriteLine(e);Assert("probe-completed",false);}
    finally {
      if(listener!=null)listener.Stop();
      if(sid!=IntPtr.Zero)FreeSid(sid);
      if(created)Assert("profile-deleted",DeleteAppContainerProfile(profile)==0);
    }
    return failures==0?0:1;
  }
}
