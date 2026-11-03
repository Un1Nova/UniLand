package atlas;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

/** Resolve guide/wiki resources through the active resource manager and pack precedence. */
public class KnowledgeCapture extends RuntimeExport {
  public static void start(Object mc)throws Exception {
    gson=cls("com.google.gson.Gson").getConstructor().newInstance();
    snapshot=output.resolve("knowledge-"+System.currentTimeMillis());Files.createDirectories(snapshot);
    Thread worker=new Thread(()->{
      try {
        List<Object> resources=new ArrayList<>();List<Object> manifest=new ArrayList<>();
        Object manager=field(mc,"field_110451_am");
        onMain(mc,()->{
          for(String prefix:List.of("guides","wiki")) {
            Object location=cls("net.minecraft.util.ResourceLocation").getConstructor(String.class,String.class).newInstance("luminous",prefix);
            resources.addAll((Collection<?>)invoke(manager,"listResources",new Class<?>[]{cls("net.minecraft.util.ResourceLocation"),boolean.class},location,true));
          }
          Object mods=call(cls("cpw.mods.fml.common.Loader"),"instance");List<Object> ids=new ArrayList<>();
          for(Object mod:(Collection<?>)call(mods,"getActiveModList"))ids.add(call(mod,"getModId"));
          json("session.json",Map.of("observedAt",Instant.now().toString(),"runtimeExport",true,"worldPresent",field(mc,"field_71441_e")!=null,"mods",ids,"listedResourceCount",resources.size(),"resolution","active IResourceManager, winning resource-pack version"));
        });
        Set<String> done=new HashSet<>();
        for(Object location:resources) {
          String key=location.toString();if(!done.add(key))continue;
          if(!(key.startsWith("luminous:guides/")||key.startsWith("luminous:wiki/")))throw new IllegalArgumentException("Unexpected resource domain");
          onMain(mc,()->{
            Map<String,Object> row=new LinkedHashMap<>();row.put("resource",key);
            try {
              Object resource=invoke(manager,"func_110536_a",new Class<?>[]{cls("net.minecraft.util.ResourceLocation")},location);
              byte[] data;try(InputStream stream=(InputStream)call(resource,"func_110527_b")){data=stream.readAllBytes();}
              String file=hash(key.getBytes(java.nio.charset.StandardCharsets.UTF_8))+".bin";
              Files.write(snapshot.resolve(file),data);row.put("file",file);row.put("sha256",hash(data));row.put("size",data.length);
            }catch(Throwable e){row.put("error",error(e));}
            manifest.add(row);
          });
        }
        json("manifest.json",manifest);Files.writeString(snapshot.resolve("finished.txt"),Instant.now().toString());
        Files.writeString(output.resolve("latest-knowledge.txt"),snapshot.getFileName().toString());
      }catch(Throwable e){try{Files.writeString(snapshot.resolve("error.txt"),error(e));}catch(Exception ignored){}}
    },"UniLand guide resources");worker.setDaemon(true);worker.start();
  }
}
