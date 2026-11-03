package atlas;

import java.lang.reflect.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/** Read-only game-thread snapshot. Does not serialize account or player objects. */
public final class RuntimeDump {
  static ClassLoader loader;
  static Path out;
  static Object mc,gson,itemRegistry;
  static final Map<String,Object> items=new LinkedHashMap<>(), stacks=new LinkedHashMap<>();
  static final List<Object> coverage=new ArrayList<>(), errors=new ArrayList<>();
  static int fieldErrors=0;
  static Class<?> c(String n)throws Exception{return Class.forName(n,false,loader);}
  static Object f(Object o,String n)throws Exception{
    Class<?> k=o instanceof Class<?>?(Class<?>)o:o.getClass();
    for(;k!=null;k=k.getSuperclass())try{Field f=k.getDeclaredField(n);f.setAccessible(true);return f.get(o instanceof Class<?>?null:o);}catch(NoSuchFieldException e){}
    throw new NoSuchFieldException(n);
  }
  static Object call(Object o,String n,Object...a)throws Exception{
    Class<?> k=o instanceof Class<?>?(Class<?>)o:o.getClass();
    for(Method m:k.getMethods())if(m.getName().equals(n)&&m.getParameterCount()==a.length){
      boolean ok=true;Class<?>[] p=m.getParameterTypes();
      for(int i=0;i<a.length;i++)if(a[i]!=null&&!p[i].isPrimitive()&&!p[i].isInstance(a[i]))ok=false;
      if(ok){m.setAccessible(true);return m.invoke(o instanceof Class<?>?null:o,a);}
    }throw new NoSuchMethodException(k.getName()+"."+n);
  }
  static String json(Object o)throws Exception{return (String)call(gson,"toJson",o);}
  static void write(String name,Object o)throws Exception{Path p=out.resolve(name);Files.createDirectories(p.getParent());Files.writeString(p,json(o));}
  static String hash(String s)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8)));}
  static String err(Throwable e){while(e.getCause()!=null)e=e.getCause();return e.toString();}
  interface Job{void run()throws Exception;}
  static void game(Job job)throws Exception{
    CompletableFuture<Void> done=new CompletableFuture<>();
    call(mc,"func_152344_a",(Runnable)()->{try{job.run();done.complete(null);}catch(Throwable e){done.completeExceptionally(e);}});
    done.get(20,TimeUnit.MINUTES);
    Thread.sleep(15);
  }
  public static void start(ClassLoader l,Path target)throws Exception{
    loader=l;out=target.resolve("snapshot-"+Instant.now().toString().replace(':','-'));Files.createDirectories(out);
    mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");
    gson=c("com.google.gson.Gson").getConstructor().newInstance();
    Thread t=new Thread(()->{try{run(target);}catch(Throwable e){try{write("fatal.json",Map.of("error",err(e)));}catch(Exception ignored){}}},"UniLand export");t.setDaemon(true);t.start();
  }
  static Object raw(Object o)throws Exception{return raw(o,new IdentityHashMap<>(),0);}
  static Object raw(Object o,IdentityHashMap<Object,Integer> seen,int depth)throws Exception{
    if(o==null||o instanceof String||o instanceof Boolean||o instanceof Integer||o instanceof Short||o instanceof Byte)return o;
    if(o instanceof Long)return Map.of("$type","long","value",o.toString());
    if(o instanceof Number)return Double.isFinite(((Number)o).doubleValue())?o:Map.of("$type",o.getClass().getName(),"value",o.toString());
    if(o instanceof Character||o instanceof Enum<?>||o instanceof Class<?>)return o.toString();
    String n=o.getClass().getName();
    if(o instanceof java.awt.Color)return Map.of("$type","color","argb",((java.awt.Color)o).getRGB());
    if(n.startsWith("java.nio.")||n.startsWith("jdk.internal.ref.")||n.startsWith("java.lang.ref."))return Map.of("$runtimeInfrastructure",n);
    if(n.equals("net.minecraft.item.ItemStack"))return stack(o);
    if(n.equals("net.minecraftforge.fluids.FluidStack")){
      Map<String,Object> r=new LinkedHashMap<>();r.put("$type","fluid-stack");r.put("fluid",call(call(o,"getFluid"),"getName"));r.put("amount",f(o,"amount"));r.put("unit","mB");Object t=f(o,"tag");r.put("nbt",t==null?null:nbt(t));return r;
    }
    if(c("net.minecraftforge.fluids.Fluid").isInstance(o))return Map.of("$type","fluid","id",call(o,"getName"));
    if(c("net.minecraft.util.IIcon").isInstance(o))return Map.of("$type","icon-resource","name",call(o,"func_94215_i"));
    if(c("net.minecraft.block.Block").isInstance(o))return Map.of("$type","block","registryId",String.valueOf(call(f(c("net.minecraft.block.Block"),"field_149771_c"),"func_148750_c",o)));
    if(c("net.minecraft.item.Item").isInstance(o))return Map.of("$type","item","registryId",String.valueOf(call(itemRegistry,"func_148750_c",o)));
    if(n.startsWith("net.minecraft.nbt."))return nbt(o);
    if(n.equals("net.minecraft.util.ResourceLocation"))return Map.of("$type","resource","value",o.toString());
    if(n.startsWith("net.minecraft.world.")||n.startsWith("net.minecraft.entity.")||n.startsWith("net.minecraft.client.Minecraft")||n.contains("ClassLoader")||n.startsWith("java.lang.reflect.")||n.startsWith("io.netty."))return Map.of("$excludedType",n);
    if(seen.containsKey(o))return Map.of("$ref",seen.get(o));
    if(depth>36){fieldErrors++;return Map.of("$truncatedType",n);}
    int id=seen.size();seen.put(o,id);
    Map<String,Object> r=new LinkedHashMap<>();r.put("$id",id);r.put("$type",n);
    if(o instanceof Map<?,?>){List<Object> entries=new ArrayList<>();for(var e:((Map<?,?>)o).entrySet())entries.add(Arrays.asList(raw(e.getKey(),seen,depth+1),raw(e.getValue(),seen,depth+1)));r.put("entries",entries);return r;}
    if(o instanceof Iterable<?>){List<Object> entries=new ArrayList<>();for(Object x:(Iterable<?>)o)entries.add(raw(x,seen,depth+1));r.put("values",entries);return r;}
    if(o.getClass().isArray()){List<Object> entries=new ArrayList<>();for(int i=0;i<Array.getLength(o);i++)entries.add(raw(Array.get(o,i),seen,depth+1));r.put("values",entries);return r;}
    if(n.startsWith("kotlin.jvm.internal.")||n.contains("$$Lambda")){r.put("dynamicRule",true);return r;}
    Map<String,Object> fields=new LinkedHashMap<>();
    for(Class<?> k=o.getClass();k!=null&&k!=Object.class;k=k.getSuperclass())for(Field q:k.getDeclaredFields()){
      if(Modifier.isStatic(q.getModifiers())||q.isSynthetic())continue;
      try{q.setAccessible(true);fields.put(k.getName()+"."+q.getName(),raw(q.get(o),seen,depth+1));}
      catch(Throwable e){fieldErrors++;fields.put(k.getName()+"."+q.getName(),Map.of("$error",err(e)));}
    }r.put("fields",fields);return r;
  }
  static Object nbt(Object tag)throws Exception{
    int type=((Number)call(tag,"func_74732_a")).intValue();Object value=null;
    if(type==10){Map<String,Object> m=new TreeMap<>();for(var e:((Map<?,?>)f(tag,"field_74784_a")).entrySet())m.put(e.getKey().toString(),nbt(e.getValue()));value=m;}
    else if(type==9){List<Object> v=new ArrayList<>();for(Object x:(List<?>)f(tag,"field_74747_a"))v.add(nbt(x));return Map.of("type",type,"elementType",call(tag,"func_150303_d"),"value",v);}
    else for(Field q:tag.getClass().getDeclaredFields())if(!Modifier.isStatic(q.getModifiers())&&!q.isSynthetic()){q.setAccessible(true);Object v=q.get(tag);if(v instanceof Number||v instanceof String||v!=null&&v.getClass().isArray()){value=v instanceof Long?v.toString():v;break;}}
    Map<String,Object> r=new LinkedHashMap<>();r.put("type",type);r.put("value",value);return r;
  }
  static Object stack(Object s)throws Exception{
    Object item=call(s,"func_77973_b");if(item==null)return Map.of("$type","empty-stack");
    String registry=String.valueOf(call(itemRegistry,"func_148750_c",item));Object tag=call(s,"func_77978_p");Object typed=tag==null?null:nbt(tag);
    int damage=((Number)call(s,"func_77960_j")).intValue();String id=registry+"@"+damage+(typed==null?"":"#"+hash(json(typed)));
    if(!items.containsKey(id)){
      Map<String,Object> v=new LinkedHashMap<>();v.put("id",id);v.put("registryId",registry);v.put("damage",damage);v.put("nbt",typed);v.put("modId",registry.contains(":")?registry.split(":",2)[0]:"minecraft");
      try{v.put("name",call(s,"func_82833_r"));v.put("translationKey",call(s,"func_77977_a"));}catch(Throwable e){v.put("nameError",err(e));}
      v.put("icon","sprites/"+hash(id)+".png");items.put(id,v);stacks.put(id,call(s,"func_77946_l"));
    }return Map.of("$type","stack","itemId",id,"count",f(s,"field_77994_a"));
  }
  static void record(String name,Object source)throws Exception{
    int count=source instanceof Collection<?>?((Collection<?>)source).size():source instanceof Map<?,?>?((Map<?,?>)source).size():-1;
    int before=fieldErrors;Map<String,Object> doc=new LinkedHashMap<>();doc.put("source",name);doc.put("sourceCount",count);doc.put("data",raw(source));write("registries/"+hash(name)+".json",doc);
    coverage.add(Map.of("source",name,"sourceCount",count,"path","registries/"+hash(name)+".json","serializationErrors",fieldErrors-before));
  }
  static void task(String label,Job j)throws Exception{write("progress.json",Map.of("stage",label,"items",items.size(),"registries",coverage.size(),"at",Instant.now().toString()));try{game(j);}catch(Throwable e){errors.add(Map.of("source",label,"error",err(e)));}}
  @SuppressWarnings("unchecked") public static void finish(ClassLoader l,Path p)throws Exception{
    loader=l;out=p;mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");gson=c("com.google.gson.Gson").getConstructor().newInstance();itemRegistry=f(c("net.minecraft.item.Item"),"field_150901_e");SpriteDump.loader=l;
    for(Object x:(List<?>)call(gson,"fromJson",Files.readString(out.resolve("items.json")),List.class)){Map<String,Object> m=(Map<String,Object>)x;items.put(m.get("id").toString(),m);}
    Thread t=new Thread(()->{try{
      if(f(mc,"field_71441_e")==null)throw new IllegalStateException("World required");
      task("energistics-native",()->{for(Field q:c("ru.loliland.le.common.recipe.OO10lO1LANd").getFields())if(Modifier.isStatic(q.getModifiers()))record("ru.loliland.le.common.recipe.OO10lO1LANd\t"+q.getName(),q.get(null));});
      task("bloodmagic-guide-null-check",()->record("WayofTime.alchemicalWizardry.common.guide.RecipeHolder\trecipeList",f(c("WayofTime.alchemicalWizardry.common.guide.RecipeHolder"),"recipeList")));
      List<Object> evidence=(List<Object>)call(gson,"fromJson",Files.readString(out.resolve("nei-coverage.json")),List.class);
      Object bridge=f(c("loliland.luminous.ui.recipe.bridge.NeiRecipeBridge"),"INSTANCE");Method extract=bridge.getClass().getDeclaredMethod("extractRecipes",c("codechicken.nei.recipe.IRecipeHandler"));extract.setAccessible(true);
      for(String name:List.of("ru.loliland.le.integration.notenoughitems.NEILaserDrillHandler","ru.loliland.le.integration.notenoughitems.NEIDrillComplexHandler","vazkii.botania.client.integration.nei.recipe.RecipeHandlerFloatingFlowers")){
        Object h=c(name).getConstructor().newInstance();List<Object> candidates=new ArrayList<>(items.values());
        for(int offset=0;offset<candidates.size();offset+=128){List<Object> batch=candidates.subList(offset,Math.min(offset+128,candidates.size()));task("item-query:"+name+":"+offset,()->{for(Object row:batch){Map<String,Object> item=(Map<String,Object>)row;if(((Number)item.get("damage")).intValue()==32767)continue;call(h,"loadCraftingRecipes",SpriteDump.stack(item));}});}
        task("query-export:"+name,()->{Object records=extract.invoke(bridge,h);int count=((Number)call(h,"numRecipes")).intValue();String type=name.contains("LaserDrill")?"laser_drill":name.contains("DrillComplex")?"drill_complex":"crafting";String source="nei:"+type+":"+name;record(source,records);record("nei-native:"+name,f(h,"arecipes"));evidence.removeIf(x->name.equals(((Map<?,?>)x).get("class")));evidence.add(Map.of("class",name,"overlay",String.valueOf(call(h,"getOverlayIdentifier")),"type",type,"sourceCount",count,"exportedCount",((List<?>)records).size(),"queryMode","all-catalog-item-variants","queriedVariants",candidates.size(),"path","registries/"+hash(source)+".json"));});
      }
      task("fluid-descriptions",()->{List<Object> fluids=new ArrayList<>();for(Object fluid:((Map<?,?>)call(c("net.minecraftforge.fluids.FluidRegistry"),"getRegisteredFluids")).values()){Map<String,Object> row=new LinkedHashMap<>();row.put("id",call(fluid,"getName"));for(String method:List.of("getLocalizedName","getUnlocalizedName","getColor","getDensity","getTemperature","getViscosity","isGaseous","getStillIcon","getFlowingIcon"))try{row.put(method,raw(call(fluid,method)));}catch(NoSuchMethodException ignored){}fluids.add(row);}write("fluids.json",fluids);});
      write("items.json",new ArrayList<>(items.values()));write("nei-coverage.json",evidence);write("finish-coverage.json",coverage);write("finish-errors.json",errors);write("finish-state.json",Map.of("at",Instant.now().toString(),"worldPresent",f(mc,"field_71441_e")!=null,"scriptHash",HexFormat.of().formatHex((byte[])f(f(c("minetweaker.runtime.MTTweaker"),"cachedClientClasses"),"hash")),"serializationErrors",fieldErrors));write("progress.json",Map.of("stage","finish-done","items",items.size(),"serializationErrors",fieldErrors,"errors",errors.size()));
    }catch(Throwable e){try{write("finish-fatal.json",Map.of("error",err(e)));}catch(Exception ignored){}}},"UniLand item query completion");t.setDaemon(true);t.start();
  }
  @SuppressWarnings("unchecked") public static void supplement(ClassLoader l,Path p)throws Exception{
    loader=l;out=p;mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");gson=c("com.google.gson.Gson").getConstructor().newInstance();itemRegistry=f(c("net.minecraft.item.Item"),"field_150901_e");
    SpriteDump.loader=l;
    for(Object x:(List<?>)call(gson,"fromJson",Files.readString(out.resolve("items.json")),List.class)){Map<String,Object> m=(Map<String,Object>)x;items.put(m.get("id").toString(),m);}
    Thread t=new Thread(()->{try{
      task("IC2-native",()->{for(Field q:c("ic2.api.recipe.Recipes").getFields())if(Modifier.isStatic(q.getModifiers()))record("ic2.api.recipe.Recipes."+q.getName(),q.get(null));});
      task("thaumonomicon",()->record("thaumcraft.api.research.ResearchCategories.researchCategories",f(c("thaumcraft.api.research.ResearchCategories"),"researchCategories")));
      task("botania-lexicon",()->record("vazkii.botania.api.BotaniaAPI.allEntries",call(c("vazkii.botania.api.BotaniaAPI"),"getAllEntries")));
      task("fluids",()->record("FluidRegistry.registeredFluids",call(c("net.minecraftforge.fluids.FluidRegistry"),"getRegisteredFluids")));
      task("quest-icons",()->{for(String file:List.of("QuestDatabase.json","QuestLineDatabase.json"))questStacks(call(gson,"fromJson",Files.readString(out.resolve(file)),Map.class));});
      task("active-packs",()->{Object repo=call(mc,"func_110438_M");List<Object> packs=new ArrayList<>();for(Object entry:(List<?>)call(repo,"func_110613_c"))packs.add(call(entry,"func_110515_d"));write("active-resourcepacks.json",packs);});
      write("items.json",new ArrayList<>(items.values()));write("supplement-coverage.json",coverage);write("supplement-errors.json",errors);
      write("progress.json",Map.of("stage","supplement-done","items",items.size(),"serializationErrors",fieldErrors));
    }catch(Throwable e){try{write("supplement-fatal.json",Map.of("error",err(e)));}catch(Exception ignored){}}},"UniLand registry supplement");t.setDaemon(true);t.start();
  }
  @SuppressWarnings("unchecked") static void questStacks(Object value)throws Exception{
    if(value instanceof Map<?,?>){Map<String,Object> m=(Map<String,Object>)value;
      if(m.get("type") instanceof Number&&((Number)m.get("type")).intValue()==10){Map<String,Object> v=(Map<String,Object>)m.get("value");
        if(v.containsKey("id")&&v.containsKey("Count")){
          Object id=((Map<?,?>)v.get("id")).get("value");Object it=call(itemRegistry,"func_82594_a",id);if(it!=null){int damage=v.containsKey("Damage")?((Number)((Map<?,?>)v.get("Damage")).get("value")).intValue():0;
            Object s=c("net.minecraft.item.ItemStack").getConstructor(c("net.minecraft.item.Item"),int.class,int.class).newInstance(it,1,damage);
            if(v.containsKey("tag"))call(s,"func_77982_d",SpriteDump.tag((Map<String,Object>)v.get("tag")));stack(s);
          }
        }
      }for(Object x:m.values())questStacks(x);
    }else if(value instanceof List<?>)for(Object x:(List<?>)value)questStacks(x);
  }
  @SuppressWarnings("unchecked") public static void repair(ClassLoader l,Path p)throws Exception{
    loader=l;out=p;mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");gson=c("com.google.gson.Gson").getConstructor().newInstance();itemRegistry=f(c("net.minecraft.item.Item"),"field_150901_e");SpriteDump.loader=l;
    for(Object x:(List<?>)call(gson,"fromJson",Files.readString(out.resolve("items.json")),List.class)){Map<String,Object> m=(Map<String,Object>)x;items.put(m.get("id").toString(),m);}
    Thread t=new Thread(()->{try{
      if(f(mc,"field_71441_e")==null)throw new IllegalStateException("Reconnect before repairing server recipe snapshot");
      Object registry=f(c("loliland.luminous.api.recipe.LoliRecipeRegistry"),"INSTANCE");
      for(Object x:(List<?>)call(gson,"fromJson",Files.readString(out.resolve("coverage.json")),List.class)){
        Map<String,Object> row=(Map<String,Object>)x;if(((Number)row.get("serializationErrors")).intValue()==0)continue;String source=row.get("source").toString();
        task("repair:"+source,()->{if(source.equals("CraftingManager.recipeList"))record(source,call(call(c("net.minecraft.item.crafting.CraftingManager"),"func_77594_a"),"func_77592_b"));
          else if(source.startsWith("luminous:"))record(source,call(call(registry,"getRecipeType",source.substring(9)),"getAllRecipes"));
          else if(source.contains("\t")){String[] a=source.split("\t");record(source,f(c(a[0]),a[1]));}
        });
      }
      List<Object> evidence=new ArrayList<>();Object bridge=f(c("loliland.luminous.ui.recipe.bridge.NeiRecipeBridge"),"INSTANCE");
      Method extract=bridge.getClass().getDeclaredMethod("extractRecipes",c("codechicken.nei.recipe.IRecipeHandler"));extract.setAccessible(true);
      List<Object> prototypes=new ArrayList<>();for(String field:List.of("craftinghandlers","serialCraftingHandlers"))prototypes.addAll((List<?>)f(c("codechicken.nei.recipe.GuiCraftingRecipe"),field));
      for(Object proto:prototypes)task("NEI:"+proto.getClass().getName(),()->{
        String overlay=String.valueOf(call(proto,"getOverlayIdentifier"));Object h=call(proto,"getRecipeHandler",overlay,new Object[0]);int count=((Number)call(h,"numRecipes")).intValue();
        if(count==0){Set<String> candidates=new LinkedHashSet<>();for(String method:List.of("getRecipeId","getRecipeID"))try{Object id=call(proto,method);if(id!=null)candidates.add(id.toString());}catch(Exception ignored){}
          try{for(Object rect:(Collection<?>)f(proto,"transferRects"))candidates.add(f(rect,"outputId").toString());}catch(Exception ignored){}
          for(String candidate:candidates){Object test=call(proto,"getRecipeHandler",candidate,new Object[0]);int n=((Number)call(test,"numRecipes")).intValue();if(n>count){h=test;count=n;overlay=candidate;}}
        }
        Object records=extract.invoke(bridge,h);
        Object type=call(registry,"resolveNeiHandler",overlay,h.getClass().getName());String id=type==null?h.getClass().getName():call(type,"getId").toString();
        record("nei:"+id+":"+h.getClass().getName(),records);
        if(count!=((List<?>)records).size())record("nei-native:"+h.getClass().getName(),f(h,"arecipes"));
        evidence.add(Map.of("class",h.getClass().getName(),"overlay",overlay,"type",id,"sourceCount",count,"exportedCount",((List<?>)records).size(),"path","registries/"+hash("nei:"+id+":"+h.getClass().getName())+".json"));
      });
      task("brewing-rules",()->{for(Field q:c("net.minecraft.potion.PotionHelper").getDeclaredFields())if(Modifier.isStatic(q.getModifiers())&&(q.getType()==String.class||Map.class.isAssignableFrom(q.getType()))){q.setAccessible(true);Object value=q.get(null);if(value!=null)record("PotionHelper."+q.getName(),value);}});
      write("nei-coverage.json",evidence);write("repair-coverage.json",coverage);write("repair-errors.json",errors);write("items.json",new ArrayList<>(items.values()));
      write("repair-state.json",Map.of("at",Instant.now().toString(),"worldPresent",f(mc,"field_71441_e")!=null,"scriptHash",HexFormat.of().formatHex((byte[])f(f(c("minetweaker.runtime.MTTweaker"),"cachedClientClasses"),"hash")),"serializationErrors",fieldErrors));
      write("progress.json",Map.of("stage","repair-done","items",items.size(),"serializationErrors",fieldErrors,"errors",errors.size()));
    }catch(Throwable e){try{write("repair-fatal.json",Map.of("error",err(e)));}catch(Exception ignored){}}},"UniLand snapshot repairs");t.setDaemon(true);t.start();
  }
  static void run(Path control)throws Exception{
    itemRegistry=f(c("net.minecraft.item.Item"),"field_150901_e");
    game(()->{
      Map<String,Object> state=new LinkedHashMap<>();state.put("exportedAt",Instant.now().toString());state.put("worldPresent",f(mc,"field_71441_e")!=null);state.put("playerPresent",f(mc,"field_71439_g")!=null);state.put("singleplayer",call(mc,"func_71356_B"));
      Object cached=f(c("minetweaker.runtime.MTTweaker"),"cachedClientClasses");state.put("serverScriptCachePresent",cached!=null);
      if(cached!=null){state.put("scriptHash",HexFormat.of().formatHex((byte[])f(cached,"hash")));state.put("scriptClasses",((Map<?,?>)f(cached,"classes")).size());}
      write("state.json",state);
    });
    for(String q:List.of("QuestDatabase","QuestLineDatabase"))task(q,()->{
      Object db=f(c("betterquesting.questing."+q),"INSTANCE");Object tag=c("net.minecraft.nbt.NBTTagList").getConstructor().newInstance();
      Object data=call(db,"writeToNBT",tag,null);write(q+".json",Map.of("sourceCount",call(db,"size"),"data",nbt(data)));
    });
    task("vanilla-crafting",()->record("CraftingManager.recipeList",call(call(c("net.minecraft.item.crafting.CraftingManager"),"func_77594_a"),"func_77592_b")));
    task("vanilla-smelting",()->record("FurnaceRecipes.smeltingList",call(call(c("net.minecraft.item.crafting.FurnaceRecipes"),"func_77602_a"),"func_77599_b")));
    final List<Object> types=new ArrayList<>();game(()->types.addAll((Collection<?>)call(f(c("loliland.luminous.api.recipe.LoliRecipeRegistry"),"INSTANCE"),"getAllRecipeTypes")));
    List<Object> handlers=new ArrayList<>();
    for(Object type:types)task("luminous:"+call(type,"getId"),()->{
      Map<String,Object> h=new LinkedHashMap<>();String id=call(type,"getId").toString();h.put("id",id);h.put("class",type.getClass().getName());h.put("name",call(type,"getDisplayName"));h.put("icon",raw(call(type,"getIcon")));
      Object all=call(type,"getAllRecipes");h.put("allRecipesAvailable",all!=null);if(all!=null)record("luminous:"+id,all);
      List<Object> omni=new ArrayList<>();for(Object o:(Collection<?>)call(type,"getOmniTypes")){omni.add(Map.of("id",call(o,"getId").toString(),"class",o.getClass().getName()));record("omni:"+call(o,"getId"),o);}h.put("omni",omni);handlers.add(h);
    });write("handlers.json",handlers);
    if(Files.exists(control.resolve("registry-roots.tsv")))for(String line:Files.readAllLines(control.resolve("registry-roots.tsv"))){String[] parts=line.split("\t");if(parts.length!=2)continue;task(line,()->record(line,f(c(parts[0]),parts[1])));}
    task("ore-dictionary",()->{List<Object> ores=new ArrayList<>();for(String name:(String[])call(c("net.minecraftforge.oredict.OreDictionary"),"getOreNames"))ores.add(Map.of("name",name,"variants",raw(call(c("net.minecraftforge.oredict.OreDictionary"),"getOres",name))));write("ores.json",ores);});
    List<Object> itemTypes=new ArrayList<>();game(()->{for(Object item:(Iterable<?>)itemRegistry)itemTypes.add(item);});
    for(Object item:itemTypes)task("item-variants:"+call(itemRegistry,"func_148750_c",item),()->{
      List<Object> variants=new ArrayList<>();call(item,"func_150895_a",item,call(item,"func_77640_w"),variants);
      if(variants.isEmpty())variants.add(c("net.minecraft.item.ItemStack").getConstructor(c("net.minecraft.item.Item")).newInstance(item));
      for(Object stack:variants)stack(stack);
    });
    write("items.json",new ArrayList<>(items.values()));write("coverage.json",coverage);write("errors.json",errors);
    write("progress.json",Map.of("stage","data-snapshot-done","items",items.size(),"registries",coverage.size(),"errors",errors.size(),"serializationErrors",fieldErrors));
    Files.writeString(control.resolve("latest-snapshot.txt"),out.toString());
  }
}
