package atlas.bootstrap;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.event.FMLInitializationEvent;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.Properties;

/** Local, opt-in read-only collector. Does not register packets or change recipes. */
@Mod(modid="uniland_exporter", name="UniLand local exporter", version="0.1.0", acceptableRemoteVersions="*")
public class AtlasBootstrap {
  private Path output, worker;
  private int ticks;
  @Mod.EventHandler public void init(FMLInitializationEvent event) throws Exception {
    Properties p = new Properties();
    try(InputStream in=getClass().getResourceAsStream("/atlas-local.properties")) {p.load(in);}
    output=Paths.get(p.getProperty("output"));worker=Paths.get(p.getProperty("worker"));
    Files.createDirectories(output);
    Files.write(output.resolve("bootstrap-ready.txt"),"Ready; waiting for request.txt".getBytes("UTF-8"));
    FMLCommonHandler.instance().bus().register(this);
  }
  @SubscribeEvent public void tick(TickEvent.ClientTickEvent event) {
    if(event.phase!=TickEvent.Phase.END || ++ticks%40!=0) return;
    Path request=output.resolve("request.txt");
    if(!Files.isRegularFile(request))return;
    try {
      String mode=new String(Files.readAllBytes(request),"UTF-8").trim();
      if(!mode.equals("probe"))throw new IllegalArgumentException("Unknown request");
      Files.move(request,output.resolve("request-running.txt"),StandardCopyOption.REPLACE_EXISTING);
      // New classloader per request permits work on adapters without game restarts.
      URLClassLoader isolated=new URLClassLoader(new URL[]{worker.toUri().toURL()},getClass().getClassLoader());
      Class<?> probe=Class.forName("atlas.RuntimeProbe",true,isolated);
      probe.getMethod("start",ClassLoader.class,Path.class).invoke(null,getClass().getClassLoader(),output);
    }catch(Throwable e) {
      try {Files.write(output.resolve("bootstrap-error.txt"),e.toString().getBytes("UTF-8"));}
      catch(Exception ignored){}
    }
  }
}
