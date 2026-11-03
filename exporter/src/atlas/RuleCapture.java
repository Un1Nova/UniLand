package atlas;
import java.nio.file.*;
import java.util.*;
import static atlas.RuntimeDump.*;

/** Preserve server-delivered compiled recipe definitions; never account/session objects. */
public final class RuleCapture {
  public static void start(ClassLoader l,Path p)throws Exception{
    loader=l;out=p;mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");gson=c("com.google.gson.Gson").getConstructor().newInstance();
    Thread t=new Thread(()->{try{game(()->{
      if(f(mc,"field_71441_e")==null)throw new IllegalStateException("World required");
      Object cache=f(c("minetweaker.runtime.MTTweaker"),"cachedClientClasses");
      Map<?,?> classes=(Map<?,?>)f(cache,"classes");List<Object> rows=new ArrayList<>();Files.createDirectories(out.resolve("script-classes"));
      for(var e:classes.entrySet()){
        if(!(e.getValue() instanceof byte[]))throw new IllegalStateException("Unexpected compiled script value type");
        byte[] data=(byte[])e.getValue();String digest=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(data));String path="script-classes/"+digest+".class";Files.write(out.resolve(path),data);rows.add(Map.of("class",e.getKey().toString(),"file",path,"sha256",digest,"sizeBytes",data.length));
      }
      write("script-classes.json",Map.of("scriptHash",HexFormat.of().formatHex((byte[])f(cache,"hash")),"sourceCount",classes.size(),"entries",rows));
    });}catch(Throwable e){try{write("script-classes-error.json",Map.of("error",err(e)));}catch(Exception ignored){}}},"UniLand synchronized script definitions");t.setDaemon(true);t.start();
  }
}
