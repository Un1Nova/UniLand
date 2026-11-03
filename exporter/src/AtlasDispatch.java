import java.lang.instrument.Instrumentation;
import java.net.*;
import java.nio.file.*;

/** Reloadable workers use versioned jars because Windows locks loaded jar files. */
public class AtlasDispatch {
  public static void agentmain(String output,Instrumentation instrumentation)throws Exception {
    Path target=Path.of(output).toAbsolutePath();
    Path build=Path.of(AtlasDispatch.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getParent();
    String worker=Files.readString(target.resolve("worker-jar.txt")).trim();
    if(!worker.matches("atlas-worker-[0-9]+[.]jar"))throw new IllegalArgumentException("Invalid worker filename");
    ClassLoader game=null;
    for(Class<?> c:instrumentation.getAllLoadedClasses())if(c.getName().equals("net.minecraft.client.Minecraft")){game=c.getClassLoader();break;}
    if(game==null)throw new IllegalStateException("Minecraft unavailable");
    URLClassLoader loader=new URLClassLoader(new URL[]{build.resolve(worker).toUri().toURL()},game){
      protected Class<?> loadClass(String name,boolean resolve)throws ClassNotFoundException {
        if(!name.startsWith("atlas."))return super.loadClass(name,resolve);
        synchronized(getClassLoadingLock(name)) {
          Class<?> c=findLoadedClass(name);if(c==null)c=findClass(name);if(resolve)resolveClass(c);return c;
        }
      }
    };
    Class.forName("atlas.RuntimeProbe",true,loader).getMethod("start",ClassLoader.class,Path.class).invoke(null,game,target);
  }
}
