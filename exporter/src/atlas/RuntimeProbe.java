package atlas;
import java.lang.reflect.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
public class RuntimeProbe {
  static ClassLoader game;
  static Path output;
  static Class<?> cls(String name) throws Exception { return Class.forName(name, false, game); }
  static Object field(Object object, String name) throws Exception {
    Class<?> c=object instanceof Class<?> ? (Class<?>)object : object.getClass();
    Field f=c.getDeclaredField(name); f.setAccessible(true); return f.get(object instanceof Class<?>?null:object);
  }
  static Object call(Object object,String name) throws Exception {
    Class<?> c=object instanceof Class<?> ? (Class<?>)object : object.getClass();
    Method m=c.getMethod(name); m.setAccessible(true); return m.invoke(object instanceof Class<?>?null:object);
  }
  public static void start(ClassLoader loader,Path target) throws Exception {
    if(Files.exists(target.resolve("web-native-request.txt"))) {
      Path snapshot=Path.of(Files.readString(target.resolve("web-native-request.txt")).trim());
      Files.delete(target.resolve("web-native-request.txt"));NativeNeiCapture.start(loader,snapshot);return;
    }
    if(Files.exists(target.resolve("rules-request.txt"))) {
      Path snapshot=Path.of(Files.readString(target.resolve("rules-request.txt")).trim());
      Files.delete(target.resolve("rules-request.txt"));RuleCapture.start(loader,snapshot);return;
    }
    if(Files.exists(target.resolve("fluid-sprites-request.txt"))) {
      Path snapshot=Path.of(Files.readString(target.resolve("fluid-sprites-request.txt")).trim());
      Files.delete(target.resolve("fluid-sprites-request.txt"));SpriteDump.startFluids(loader,snapshot);return;
    }
    if(Files.exists(target.resolve("finish-request.txt"))) {
      Path snapshot=Path.of(Files.readString(target.resolve("finish-request.txt")).trim());
      Files.delete(target.resolve("finish-request.txt"));RuntimeDump.finish(loader,snapshot);return;
    }
    if(Files.exists(target.resolve("repair-request.txt"))) {
      Path snapshot=Path.of(Files.readString(target.resolve("repair-request.txt")).trim());
      Files.delete(target.resolve("repair-request.txt"));RuntimeDump.repair(loader,snapshot);return;
    }
    if(Files.exists(target.resolve("supplement-request.txt"))) {
      Path snapshot=Path.of(Files.readString(target.resolve("supplement-request.txt")).trim());
      Files.delete(target.resolve("supplement-request.txt"));
      RuntimeDump.supplement(loader,snapshot);
      return;
    }
    if(Files.exists(target.resolve("sprites-request.txt"))) {
      Path snapshot=Path.of(Files.readString(target.resolve("sprites-request.txt")).trim());
      Files.delete(target.resolve("sprites-request.txt"));
      SpriteDump.start(loader,snapshot);
      return;
    }
    if(Files.exists(target.resolve("export-request.txt"))) {
      Files.delete(target.resolve("export-request.txt"));
      RuntimeDump.start(loader,target);
      return;
    }
    game=loader; output=target;
    Object mc=call(cls("net.minecraft.client.Minecraft"),"func_71410_x");
    if(Files.isRegularFile(target.resolve("knowledge-request.txt"))) {
      Files.delete(target.resolve("knowledge-request.txt"));
      KnowledgeCapture.start(mc);return;
    }
    mc.getClass().getMethod("func_152344_a",Runnable.class).invoke(mc,(Runnable)()->{
      try {
        run(mc);
        if(Files.isRegularFile(output.resolve("export-mode.txt"))) RuntimeExport.start(mc);
      } catch(Throwable e) { try {Files.writeString(output.resolve("probe-error.txt"),e.toString());}catch(Exception ignored){} }
    });
  }
  static Map<String,Object> describe(Object value) {
    Map<String,Object> r=new LinkedHashMap<>();
    if(value==null) {r.put("null",true);return r;}
    r.put("class",value.getClass().getName());
    if(value instanceof Collection<?>)r.put("size",((Collection<?>)value).size());
    if(value instanceof Map<?,?>)r.put("size",((Map<?,?>)value).size());
    if(value.getClass().isArray())r.put("size",Array.getLength(value));
    for(Class<?> c=value.getClass();c!=null&&!c.getName().startsWith("java.");c=c.getSuperclass()) {
      for(Field f:c.getDeclaredFields()) try {
        f.setAccessible(true); Object v=f.get(value);
        if(v instanceof Collection<?>) r.put(c.getName()+"."+f.getName(),Map.of("size",((Collection<?>)v).size(),"kind","collection"));
        else if(v instanceof Map<?,?>)r.put(c.getName()+"."+f.getName(),Map.of("size",((Map<?,?>)v).size(),"kind","map"));
        else if(v!=null&&v.getClass().isArray())r.put(c.getName()+"."+f.getName(),Map.of("size",Array.getLength(v),"kind","array"));
      } catch(Exception ignored) {}
    }
    return r;
  }
  static void run(Object mc) throws Exception {
    Map<String,Object> root=new LinkedHashMap<>();
    root.put("observedAt",Instant.now().toString());
    root.put("worldPresent",field(mc,"field_71441_e")!=null);
    root.put("playerPresent",field(mc,"field_71439_g")!=null);
    root.put("singleplayer",call(mc,"func_71356_B"));
    root.put("forgeVersion",call(cls("net.minecraftforge.common.ForgeVersion"),"getVersion"));
    try {
      Object loader=call(cls("cpw.mods.fml.common.Loader"),"instance");
      List<Object> mods=new ArrayList<>();
      for(Object mod:(Collection<?>)call(loader,"getActiveModList"))
        mods.add(Map.of("id",call(mod,"getModId"),"name",call(mod,"getName"),"version",call(mod,"getVersion")));
      root.put("mods",mods);
    }catch(Exception e){root.put("modsError",e.toString());}
    for(String name:List.of("betterquesting.questing.QuestDatabase","betterquesting.questing.QuestLineDatabase")) {
      try {root.put(name,Map.of("sourceCount",call(field(cls(name),"INSTANCE"),"size")));}
      catch(Exception e){root.put(name,Map.of("error",e.toString()));}
    }
    for(String path:List.of("codechicken.nei.recipe.GuiCraftingRecipe.craftinghandlers","codechicken.nei.recipe.GuiCraftingRecipe.serialCraftingHandlers","codechicken.nei.recipe.GuiUsageRecipe.usagehandlers","codechicken.nei.recipe.GuiUsageRecipe.serialUsageHandlers","codechicken.nei.ItemList.items")) {
      try {
        int i=path.lastIndexOf('.'); Object v=field(cls(path.substring(0,i)),path.substring(i+1));
        if(path.endsWith(".items"))root.put(path,describe(v));
        else {List<Object> list=new ArrayList<>();for(Object x:(Collection<?>)v)list.add(describe(x));root.put(path,list);}
      }catch(Exception e){root.put(path,Map.of("error",e.toString()));}
    }
    try {
      Object registry=field(cls("loliland.luminous.api.recipe.LoliRecipeRegistry"),"INSTANCE");
      List<Object> types=new ArrayList<>();
      for(Object x:(Collection<?>)call(registry,"getAllRecipeTypes")) {
        Map<String,Object> r=describe(x); r.put("id",call(x,"getId"));r.put("displayName",call(x,"getDisplayName"));types.add(r);
      }
      root.put("luminousTypes",types);
    }catch(Exception e){root.put("luminousError",e.toString());}
    for(String name:List.of("minetweaker.runtime.MTTweaker","minetweaker.runtime.CachedClasses$Client","stanhebben.zenscript.ZenModule")) {
      List<Object> fields=new ArrayList<>();
      for(Field f:cls(name).getDeclaredFields()) {
        Map<String,Object> r=new LinkedHashMap<>();r.put("name",f.getName());r.put("type",f.getType().getName());
        if(Modifier.isStatic(f.getModifiers())) {f.setAccessible(true);r.put("summary",describe(f.get(null)));}
        fields.add(r);
      }root.put(name,fields);
    }
    Object gson=cls("com.google.gson.Gson").getConstructor().newInstance();
    String json=(String)gson.getClass().getMethod("toJson",Object.class).invoke(gson,root);
    Files.writeString(output.resolve("probe.json"),json);
  }
}
