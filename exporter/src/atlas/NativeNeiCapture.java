package atlas;
import java.nio.file.*;
import java.util.*;
import static atlas.RuntimeDump.*;

/** Preserve all NEI cached recipe properties, including fluid-only outputs and chance/energy. */
public final class NativeNeiCapture {
  @SuppressWarnings("unchecked") public static void start(ClassLoader l,Path p)throws Exception{
    loader=l;out=p;mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");gson=c("com.google.gson.Gson").getConstructor().newInstance();itemRegistry=f(c("net.minecraft.item.Item"),"field_150901_e");
    for(Object x:(List<?>)call(gson,"fromJson",Files.readString(out.resolve("items.json")),List.class)){Map<String,Object> m=(Map<String,Object>)x;items.put(m.get("id").toString(),m);}
    Thread t=new Thread(()->{try{
      if(f(mc,"field_71441_e")==null)throw new IllegalStateException("World required");
      for(Object value:(List<?>)call(gson,"fromJson",Files.readString(out.resolve("nei-coverage.json")),List.class)){
        Map<String,Object> row=(Map<String,Object>)value;if(row.containsKey("queryMode"))continue;
        String name=row.get("class").toString();task("native-nei:"+name,()->{Object proto=c(name).getConstructor().newInstance();Object h=call(proto,"getRecipeHandler",row.get("overlay").toString(),new Object[0]);int count=((Number)call(h,"numRecipes")).intValue();if(count!=((Number)row.get("sourceCount")).intValue())throw new IllegalStateException("NEI count changed: "+name+" "+count);record("nei-native:"+name,f(h,"arecipes"));});
      }
      write("items.json",new ArrayList<>(items.values()));write("web-native-coverage.json",coverage);write("web-native-errors.json",errors);write("web-native-state.json",Map.of("at",java.time.Instant.now().toString(),"worldPresent",true,"scriptHash",HexFormat.of().formatHex((byte[])f(f(c("minetweaker.runtime.MTTweaker"),"cachedClientClasses"),"hash")),"serializationErrors",fieldErrors));write("progress.json",Map.of("stage","web-native-done","items",items.size(),"errors",errors.size(),"serializationErrors",fieldErrors));
    }catch(Throwable e){try{write("web-native-fatal.json",Map.of("error",err(e)));}catch(Exception ignored){}}},"UniLand native recipe properties");t.setDaemon(true);t.start();
  }
}
