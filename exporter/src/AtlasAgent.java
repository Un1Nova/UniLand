import java.lang.instrument.Instrumentation;
import java.lang.reflect.*;
import java.net.*;
import java.nio.file.*;
public class AtlasAgent {
  public static void premain(String output, Instrumentation instrumentation) {
    // A startup agent uses the standard JVM option; no attach mechanism or game files are changed.
    Thread controller=new Thread(()->{
      try {
        Path target=Path.of(output).toAbsolutePath();
        Files.createDirectories(target);
        Files.writeString(target.resolve("agent-vm-"+ProcessHandle.current().pid()+".txt"),"Startup agent loaded; Java "+System.getProperty("java.version"));
        boolean ready=false;
        long firstSeen=0;
        while(true) {
          Class<?> minecraft=null;
          for(Class<?> c:instrumentation.getAllLoadedClasses())
            if(c.getName().equals("net.minecraft.client.Minecraft")) { minecraft=c;break; }
          if(minecraft!=null && firstSeen==0)firstSeen=System.currentTimeMillis();
          if(minecraft!=null && System.currentTimeMillis()-firstSeen>15000
              && minecraft.getMethod("func_71410_x").invoke(null)!=null) {
            Files.createDirectories(target);
            if(!ready) {Files.writeString(target.resolve("startup-agent-ready.txt"),"Standard startup agent active");ready=true;}
            Path request=target.resolve("request.txt");
            if(Files.isRegularFile(request)) {
              if(!Files.readString(request).trim().equals("probe"))throw new IllegalArgumentException("Unsupported request");
              Files.move(request,target.resolve("request-running.txt"),StandardCopyOption.REPLACE_EXISTING);
              try {agentmain(output,instrumentation);}
              catch(Throwable e) {Files.writeString(target.resolve("startup-agent-error.txt"),e.toString());}
            }
          }
          Thread.sleep(2000);
        }
      }catch(Throwable e) {
        try {Files.writeString(Path.of(output).resolve("startup-agent-error.txt"),e.toString());}catch(Exception ignored){}
      }
    },"UniLand local export control");
    controller.setDaemon(true);controller.start();
  }
  public static void agentmain(String output, Instrumentation instrumentation) throws Exception {
    Path target = Path.of(output).toAbsolutePath();
    Files.createDirectories(target);
    ClassLoader game = null;
    for (Class<?> c : instrumentation.getAllLoadedClasses())
      if (c.getName().equals("net.minecraft.client.Minecraft")) { game = c.getClassLoader(); break; }
    if (game == null) throw new IllegalStateException("Minecraft is not loaded");
    // Isolate each run so rebuilding the exporter does not require a game restart.
    Path ownJar=Path.of(AtlasAgent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    URL jar = ownJar.resolveSibling("atlas-worker.jar").toUri().toURL();
    URLClassLoader loader = new URLClassLoader(new URL[]{jar}, game) {
      protected Class<?> loadClass(String name,boolean resolve) throws ClassNotFoundException {
        if(!name.startsWith("atlas."))return super.loadClass(name,resolve);
        synchronized(getClassLoadingLock(name)) {
          Class<?> c=findLoadedClass(name);if(c==null)c=findClass(name);if(resolve)resolveClass(c);return c;
        }
      }
    };
    Class<?> worker = Class.forName("atlas.RuntimeProbe", true, loader);
    worker.getMethod("start", ClassLoader.class, Path.class).invoke(null, game, target);
  }
}
