package atlas;

import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/** Read-only capture of recipe sources and quest definitions. Never visits player fields. */
public class RuntimeExport extends RuntimeProbe {
  static final Map<String,Object> items=new LinkedHashMap<>();
  static final Map<String,Integer> unsupported=new TreeMap<>();
  static Object gson;
  static Path snapshot;
  static final List<Object> coverage=new ArrayList<>();

  interface Work { void run() throws Exception; }
  static void onMain(Object mc,Work action) throws Exception {
    CompletableFuture<Void> done=new CompletableFuture<>();
    mc.getClass().getMethod("func_152344_a",Runnable.class).invoke(mc,(Runnable)()->{
      try {action.run();done.complete(null);}catch(Throwable e){done.completeExceptionally(e);}
    });
    done.get(180,TimeUnit.SECONDS);
    Thread.sleep(75);
  }
  static void json(String name,Object value) throws Exception {
    String data=(String)gson.getClass().getMethod("toJson",Object.class).invoke(gson,value);
    Files.writeString(snapshot.resolve(name),data);
  }
  static String error(Throwable e) {
    while(e.getCause()!=null)e=e.getCause();
    return e.getClass().getName(); // Avoid arbitrary exception messages containing session data.
  }
  static Object invoke(Object object,String name,Class<?>[] args,Object... values) throws Exception {
    Class<?> c=object instanceof Class<?> ? (Class<?>)object : object.getClass();
    Method m=c.getMethod(name,args);m.setAccessible(true);
    return m.invoke(object instanceof Class<?>?null:object,values);
  }
  static String hash(byte[] data)throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
  }
  static byte[] nbt(Object value)throws Exception {
    ByteArrayOutputStream buffer=new ByteArrayOutputStream();
    try(DataOutputStream data=new DataOutputStream(buffer)) {
      data.writeByte(((Number)call(value,"func_74732_a")).intValue()); data.writeUTF("");
      Method write=cls("net.minecraft.nbt.NBTBase").getDeclaredMethod("func_74734_a",DataOutput.class);
      write.setAccessible(true);write.invoke(value,data);
    }
    return buffer.toByteArray();
  }
  static Object stack(Object value)throws Exception {
    Object item=call(value,"func_77973_b");
    Object registry=field(cls("net.minecraft.item.Item"),"field_150901_e");
    String registryId=(String)invoke(registry,"func_148750_c",new Class<?>[]{Object.class},item);
    int damage=((Number)call(value,"func_77960_j")).intValue();
    Object tag=call(value,"func_77978_p"); byte[] data=tag==null?new byte[0]:nbt(tag);
    String id=registryId+"@"+damage+(data.length==0?"":"#"+hash(data));
    if(!items.containsKey(id)) {
      Map<String,Object> def=new LinkedHashMap<>();def.put("id",id);def.put("registryId",registryId);
      def.put("damage",damage);def.put("name",call(value,"func_82833_r"));
      def.put("unlocalizedName",call(value,"func_77977_a"));
      if(data.length!=0)def.put("nbt",Map.of("format","named-root-big-endian","base64",Base64.getEncoder().encodeToString(data)));
      items.put(id,def);
    }
    return Map.of("kind","item","itemId",id,"count",field(value,"field_77994_a"));
  }
  static Object value(Object v)throws Exception { return value(v,0); }
  static Object value(Object v,int depth)throws Exception {
    if(v==null||v instanceof String||v instanceof Boolean||v instanceof Integer||v instanceof Short||v instanceof Byte)return v;
    if(v instanceof Character)return v.toString();
    if(v instanceof Number)return Map.of("numberType",v.getClass().getSimpleName(),"decimal",v.toString());
    if(v instanceof Enum<?>)return Map.of("enumClass",v.getClass().getName(),"name",((Enum<?>)v).name());
    String name=v.getClass().getName();
    if(depth>24){unsupported.merge(name+":depth",1,Integer::sum);return Map.of("unresolvedClass",name,"reason","depth");}
    if(cls("net.minecraft.item.ItemStack").isInstance(v))return stack(v);
    if(cls("net.minecraft.nbt.NBTBase").isInstance(v))return Map.of("nbtBase64",Base64.getEncoder().encodeToString(nbt(v)));
    if(v instanceof Map<?,?>) {
      List<Object> entries=new ArrayList<>();
      for(Map.Entry<?,?> e:((Map<?,?>)v).entrySet())entries.add(Arrays.asList(value(e.getKey(),depth+1),value(e.getValue(),depth+1)));
      return Map.of("mapEntries",entries);
    }
    if(v instanceof Iterable<?>) {
      List<Object> entries=new ArrayList<>();for(Object e:(Iterable<?>)v)entries.add(value(e,depth+1));return entries;
    }
    if(v.getClass().isArray()) {
      List<Object> entries=new ArrayList<>();for(int i=0;i<Array.getLength(v);i++)entries.add(value(Array.get(v,i),depth+1));return entries;
    }
    if(name.equals("net.minecraftforge.fluids.FluidStack")) {
      Object fluid=call(v,"getFluid");Map<String,Object> r=new LinkedHashMap<>();
      r.put("kind","fluid");r.put("registryId",call(fluid,"getName"));r.put("name",call(v,"getLocalizedName"));
      r.put("amount",field(v,"amount"));r.put("unit","mB");r.put("nbt",value(field(v,"tag"),depth+1));return r;
    }
    if(name.equals("net.minecraft.util.ResourceLocation"))return Map.of("resourceLocation",v.toString());
    if(name.equals("loliland.luminous.api.recipe.RecipeEntry")) {
      Map<String,Object> r=new LinkedHashMap<>();
      r.put("inputs",value(call(v,"getInputs"),depth+1));r.put("outputs",value(call(v,"getOutputs"),depth+1));
      r.put("metadata",value(call(v,"getMetadata"),depth+1));return r;
    }
    if(name.equals("loliland.luminous.api.recipe.RecipeSlot"))return Map.of("variants",value(call(v,"getVariants"),depth+1),"gridX",call(v,"getGridX"),"gridY",call(v,"getGridY"));
    unsupported.merge(name,1,Integer::sum);
    return Map.of("unresolvedClass",name);
  }
  static void quests(String name,String file)throws Exception {
    Object db=field(cls(name),"INSTANCE");Object list=cls("net.minecraft.nbt.NBTTagList").getConstructor().newInstance();
    int source=((Number)call(db,"size")).intValue();
    Object saved=invoke(db,"writeToNBT",new Class<?>[]{cls("net.minecraft.nbt.NBTTagList"),List.class},list,null);
    int exported=((Number)call(saved,"func_74745_c")).intValue();
    byte[] raw=nbt(saved);Files.write(snapshot.resolve(file+".nbt"),raw);
    coverage.add(Map.of("id",name,"sourceCount",source,"exportedCount",exported,"sha256",hash(raw),"method","definition-only writeToNBT(all IDs)","status",source==exported?"exported":"partial"));
  }
  static void luminous(Object type,int index)throws Exception {
    Map<String,Object> record=new LinkedHashMap<>();
    record.put("id",call(type,"getId"));record.put("class",type.getClass().getName());
    record.put("displayName",call(type,"getDisplayName"));record.put("sourceCount",null);
    record.put("method","getAllRecipes; independent source audit pending");record.put("status","partial");
    try {
      Object all=call(type,"getAllRecipes");
      if(all==null) {
        record.put("enumerationAvailable",false);
        record.put("gap","This handler does not provide getAllRecipes; enumerate its direct registry");
        coverage.add(record);json("coverage.json",coverage);return;
      }
      Collection<?> recipes=(Collection<?>)all;
      record.put("returnedCount",recipes.size());
      List<Object> saved=new ArrayList<>();int entry=0;
      for(Object recipe:recipes) {
        try {saved.add(Map.of("sourceIndex",entry,"recipe",value(recipe)));}
        catch(Throwable e){saved.add(Map.of("sourceIndex",entry,"error",error(e)));}
        entry++;
      }
      json(String.format("luminous-%03d.json",index),saved);record.put("capturedCount",saved.size());
    }catch(Throwable e){record.put("error",error(e));}
    coverage.add(record);json("coverage.json",coverage);
  }
  public static void start(Object mc)throws Exception {
    if(field(mc,"field_71441_e")==null||Boolean.TRUE.equals(call(mc,"func_71356_B")))return;
    Files.deleteIfExists(output.resolve("export-mode.txt"));
    gson=cls("com.google.gson.Gson").getConstructor().newInstance();
    snapshot=output.resolve("capture-"+System.currentTimeMillis());Files.createDirectories(snapshot);
    Files.writeString(output.resolve("capture-path.txt"),snapshot.getFileName().toString());
    List<?> types=new ArrayList<>((Collection<?>)call(field(cls("loliland.luminous.api.recipe.LoliRecipeRegistry"),"INSTANCE"),"getAllRecipeTypes"));
    Thread worker=new Thread(()->{
      try {
        onMain(mc,()->{
          json("session.json",Map.of("observedAt",Instant.now().toString(),"worldPresent",field(mc,"field_71441_e")!=null,"singleplayer",call(mc,"func_71356_B"),"runtimeExport",true,"complete",false));
          quests("betterquesting.questing.QuestDatabase","quests");quests("betterquesting.questing.QuestLineDatabase","quest-lines");
        });
        for(int i=0;i<types.size();i++){final int n=i;onMain(mc,()->luminous(types.get(n),n));}
        onMain(mc,()->{json("items.json",items);json("unsupported.json",unsupported);json("coverage.json",coverage);});
        Files.writeString(snapshot.resolve("capture-finished.txt"),Instant.now().toString());
      }catch(Throwable e){try{Files.writeString(snapshot.resolve("capture-error.txt"),error(e));}catch(Exception ignored){}}
    },"UniLand read-only capture");worker.setDaemon(true);worker.start();
  }
}
