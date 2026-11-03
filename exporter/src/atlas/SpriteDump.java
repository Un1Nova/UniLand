package atlas;
import java.lang.reflect.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;

/** Inventory renderer capture, preserving tint, models and active resource packs. */
public final class SpriteDump {
  static boolean usedVanillaFallback;
  static ClassLoader loader;static Object mc,gson,fbo,renderer,font,textures;static Path out;
  static Class<?> c(String s)throws Exception{return Class.forName(s,false,loader);}
  static Object f(Object o,String n)throws Exception{return RuntimeDump.f(o,n);}
  static Object call(Object o,String n,Object...args)throws Exception{
    Class<?> k=o instanceof Class<?>?(Class<?>)o:o.getClass();
    for(Method m:k.getMethods())if(m.getName().equals(n)&&m.getParameterCount()==args.length){
      boolean ok=true;Class<?>[] p=m.getParameterTypes();
      for(int i=0;i<p.length;i++){
        Class<?> q=p[i];if(q.isPrimitive())q=q==int.class?Integer.class:q==float.class?Float.class:q==double.class?Double.class:q==boolean.class?Boolean.class:q==long.class?Long.class:q==byte.class?Byte.class:q==short.class?Short.class:q;
        if(args[i]!=null&&!q.isInstance(args[i]))ok=false;
      }if(ok){m.setAccessible(true);return m.invoke(o instanceof Class<?>?null:o,args);}
    }throw new NoSuchMethodException(k.getName()+"."+n+Arrays.toString(args));
  }
  static void gl(String n,Object...a)throws Exception{call(c("org.lwjgl.opengl.GL11"),n,a);}
  static void game(RuntimeDump.Job j)throws Exception{CompletableFuture<Void> d=new CompletableFuture<>();call(mc,"func_152344_a",(Runnable)()->{try{j.run();d.complete(null);}catch(Throwable e){d.completeExceptionally(e);}});d.get(5,TimeUnit.MINUTES);}
  static void write(String name,Object data)throws Exception{Files.writeString(out.resolve(name),(String)call(gson,"toJson",data));}
  @SuppressWarnings("unchecked") static Object tag(Map<String,Object> r)throws Exception{
    int t=((Number)r.get("type")).intValue();Object v=r.get("value");String[] names={"End","Byte","Short","Int","Long","Float","Double","ByteArray","String","List","Compound","IntArray"};
    Class<?> q=c("net.minecraft.nbt.NBTTag"+names[t]);
    if(t==10){Object x=q.getConstructor().newInstance();for(var e:((Map<String,Object>)v).entrySet())call(x,"func_74782_a",e.getKey(),tag((Map<String,Object>)e.getValue()));return x;}
    if(t==9){Object x=q.getConstructor().newInstance();for(Object e:(List<?>)v)call(x,"func_74742_a",tag((Map<String,Object>)e));return x;}
    if(t==7){List<?> a=(List<?>)v;byte[] x=new byte[a.size()];for(int i=0;i<x.length;i++)x[i]=((Number)a.get(i)).byteValue();return q.getConstructor(byte[].class).newInstance((Object)x);}
    if(t==11){List<?> a=(List<?>)v;int[] x=new int[a.size()];for(int i=0;i<x.length;i++)x[i]=((Number)a.get(i)).intValue();return q.getConstructor(int[].class).newInstance((Object)x);}
    if(t==8)return q.getConstructor(String.class).newInstance(v);
    Class<?>[] prim={void.class,byte.class,short.class,int.class,long.class,float.class,double.class};
    Object a=t==4?Long.valueOf(v.toString()):t==1?Byte.valueOf(((Number)v).byteValue()):t==2?Short.valueOf(((Number)v).shortValue()):t==3?Integer.valueOf(((Number)v).intValue()):t==5?Float.valueOf(((Number)v).floatValue()):Double.valueOf(((Number)v).doubleValue());
    // Explicit branches avoid numeric promotion in a conditional expression.
    if(t==1)a=Byte.valueOf(((Number)v).byteValue());if(t==2)a=Short.valueOf(((Number)v).shortValue());if(t==3)a=Integer.valueOf(((Number)v).intValue());if(t==4)a=Long.valueOf(v.toString());if(t==5)a=Float.valueOf(((Number)v).floatValue());
    return q.getConstructor(prim[t]).newInstance(a);
  }
  @SuppressWarnings("unchecked") static Object stack(Map<String,Object> item)throws Exception{
    Object registry=f(c("net.minecraft.item.Item"),"field_150901_e");Object it=call(registry,"func_82594_a",item.get("registryId"));
    Object s=c("net.minecraft.item.ItemStack").getConstructor(c("net.minecraft.item.Item"),int.class,int.class).newInstance(it,1,((Number)item.get("damage")).intValue());
    if(item.get("nbt")!=null)call(s,"func_77982_d",tag((Map<String,Object>)item.get("nbt")));return s;
  }
  static BufferedImage render(Object stack)throws Exception{
    usedVanillaFallback=false;BufferedImage img=renderPass(stack,true);
    boolean empty=true;for(int y=0;y<64&&empty;y++)for(int x=0;x<64;x++)if((img.getRGB(x,y)>>>24)!=0){empty=false;break;}
    if(empty&&c("net.minecraft.item.ItemStack").isInstance(stack)){img=renderPass(stack,false);usedVanillaFallback=true;}
    return img;
  }
  static BufferedImage renderPass(Object stack,boolean custom)throws Exception{
    Class<?> light=c("net.minecraft.client.renderer.OpenGlHelper");float oldX=((Number)f(light,"lastBrightnessX")).floatValue(),oldY=((Number)f(light,"lastBrightnessY")).floatValue();
    gl("glPushAttrib",1048575);gl("glMatrixMode",5889);gl("glPushMatrix");gl("glMatrixMode",5888);gl("glPushMatrix");
    try{
      call(light,"func_77475_a",f(light,"field_77476_b"),240f,240f);
      call(light,"func_77473_a",f(light,"field_77476_b"));gl("glDisable",3553);call(light,"func_77473_a",f(light,"field_77478_a"));
      call(fbo,"func_147610_a",true);gl("glViewport",0,0,64,64);gl("glClearColor",0f,0f,0f,0f);gl("glClear",16640);
      gl("glMatrixMode",5889);gl("glLoadIdentity");gl("glOrtho",0d,16d,16d,0d,-1000d,1000d);
      gl("glMatrixMode",5888);gl("glLoadIdentity");gl("glEnable",2929);gl("glEnable",3553);gl("glEnable",3042);gl("glEnable",3008);gl("glAlphaFunc",516,0.01f);gl("glColor4f",1f,1f,1f,1f);
      call(c("org.lwjgl.opengl.GL14"),"glBlendFuncSeparate",770,771,1,771);
      call(c("net.minecraft.client.renderer.RenderHelper"),"func_74520_c");
      if(c("net.minecraftforge.fluids.Fluid").isInstance(stack)){
        call(c("net.minecraft.client.renderer.RenderHelper"),"func_74518_a");gl("glDisable",2884);gl("glDisable",2929);
        call(textures,"func_110577_a",f(c("net.minecraft.client.renderer.texture.TextureMap"),"field_110575_b"));
        int color=((Number)call(stack,"getColor")).intValue();gl("glColor4f",((color>>16)&255)/255f,((color>>8)&255)/255f,(color&255)/255f,1f);
        Object icon=call(stack,"getStillIcon");if(icon==null)throw new IllegalStateException("Fluid has no still icon");
        call(renderer,"func_94149_a",0,0,icon,16,16);
      }else if("Botania:cocoon".equals(String.valueOf(call(f(c("net.minecraft.item.Item"),"field_150901_e"),"func_148750_c",call(stack,"func_77973_b"))))){
        // Its inventory TESR creates timePassed=0, causing sin(0)*log(0) -> NaN.
        // Capture the real model at its neutral finite pose; no world tile is touched.
        Object tile=c("vazkii.botania.common.block.tile.TileCocoon").getConstructor().newInstance();tile.getClass().getField("timePassed").setInt(tile,10);
        gl("glTranslatef",8f,12f,0f);gl("glScalef",10f,-10f,10f);gl("glRotatef",30f,1f,0f,0f);gl("glRotatef",45f,0f,1f,0f);gl("glTranslatef",-0.5f,-0.5f,-0.5f);
        call(c("vazkii.botania.client.render.tile.RenderTileCocoon").getConstructor().newInstance(),"func_147500_a",tile,0d,0d,0d,0f);
      }else if(custom)call(renderer,"func_82406_b",font,textures,stack,0,0);
      else call(renderer,"renderItemIntoGUI",font,textures,stack,0,0,true);
      ByteBuffer data=ByteBuffer.allocateDirect(64*64*4);gl("glReadPixels",0,0,64,64,6408,5121,data);
      BufferedImage img=new BufferedImage(64,64,BufferedImage.TYPE_INT_ARGB);
      for(int y=0;y<64;y++)for(int x=0;x<64;x++){int i=((63-y)*64+x)*4;img.setRGB(x,y,((data.get(i+3)&255)<<24)|((data.get(i)&255)<<16)|((data.get(i+1)&255)<<8)|(data.get(i+2)&255));}return img;
    }finally{
      call(light,"func_77475_a",f(light,"field_77476_b"),oldX,oldY);
      renderer.getClass().getField("field_77023_b").setFloat(renderer,0f);
      Object tess=f(c("net.minecraft.client.renderer.Tessellator"),"field_78398_a");
      if(Boolean.TRUE.equals(f(tess,"field_78415_z")))try{call(tess,"func_78381_a");}catch(Throwable ignored){tess.getClass().getField("field_78415_z").setBoolean(tess,false);}
      call(c("net.minecraft.client.renderer.RenderHelper"),"func_74518_a");gl("glMatrixMode",5888);gl("glPopMatrix");gl("glMatrixMode",5889);gl("glPopMatrix");gl("glMatrixMode",5888);call(call(mc,"func_147110_a"),"func_147610_a",true);gl("glPopAttrib");}
  }
  public static void start(ClassLoader l,Path p)throws Exception{
    loader=l;out=p;mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");gson=c("com.google.gson.Gson").getConstructor().newInstance();
    Thread t=new Thread(()->{try{run();}catch(Throwable e){try{write("sprites-fatal.json",Map.of("error",RuntimeDump.err(e)));}catch(Exception ignored){}}},"UniLand sprites");t.setDaemon(true);t.start();
  }
  public static void startFluids(ClassLoader l,Path p)throws Exception{
    loader=l;out=p;mc=call(c("net.minecraft.client.Minecraft"),"func_71410_x");gson=c("com.google.gson.Gson").getConstructor().newInstance();
    Thread t=new Thread(()->{try{
      Files.createDirectories(out.resolve("fluid-sprites"));List<Object> rows=new ArrayList<>();List<Object> errors=new ArrayList<>();
      game(()->{fbo=c("net.minecraft.client.shader.Framebuffer").getConstructor(int.class,int.class,boolean.class).newInstance(64,64,true);renderer=c("net.minecraft.client.renderer.entity.RenderItem").getConstructor().newInstance();font=f(mc,"field_71466_p");textures=call(mc,"func_110434_K");});
      for(Object fluid:((Map<?,?>)call(c("net.minecraftforge.fluids.FluidRegistry"),"getRegisteredFluids")).values()){
        String id=call(fluid,"getName").toString();String file="fluid-sprites/"+RuntimeDump.hash(id)+".png";BufferedImage[] result={null};
        try{game(()->result[0]=render(fluid));ImageIO.write(result[0],"PNG",out.resolve(file).toFile());rows.add(Map.of("id",id,"icon",file,"iconKind","runtime-fluid-atlas-render"));}catch(Throwable e){errors.add(Map.of("id",id,"error",RuntimeDump.err(e)));}
      }
      game(()->call(fbo,"func_147608_a"));write("fluid-sprites.json",rows);write("fluid-sprites-errors.json",errors);
    }catch(Throwable e){try{write("fluid-sprites-fatal.json",Map.of("error",RuntimeDump.err(e)));}catch(Exception ignored){}}},"UniLand fluid sprites");t.setDaemon(true);t.start();
  }
  @SuppressWarnings("unchecked") static void run()throws Exception{
    List<Map<String,Object>> items=(List<Map<String,Object>>)call(gson,"fromJson",Files.readString(out.resolve("items.json")),List.class);
    boolean force=Files.exists(out.resolve("sprites-force.txt"));
    if(force)Files.delete(out.resolve("sprites-force.txt"));
    if(Files.exists(out.resolve("sprites-retry.json"))){Set<?> retry=new HashSet<>((List<?>)call(gson,"fromJson",Files.readString(out.resolve("sprites-retry.json")),List.class));items.removeIf(x->!retry.contains(x.get("id")));Files.delete(out.resolve("sprites-retry.json"));force=true;}
    final boolean overwrite=force;
    Map<String,Object> modes=Files.exists(out.resolve("icon-render-modes.json"))?(Map<String,Object>)call(gson,"fromJson",Files.readString(out.resolve("icon-render-modes.json")),Map.class):new LinkedHashMap<>();
    Files.createDirectories(out.resolve("sprites"));List<Object> errors=new ArrayList<>();int[] count={0};
    game(()->{fbo=c("net.minecraft.client.shader.Framebuffer").getConstructor(int.class,int.class,boolean.class).newInstance(64,64,true);renderer=c("net.minecraft.client.renderer.entity.RenderItem").getConstructor().newInstance();font=f(mc,"field_71466_p");textures=call(mc,"func_110434_K");});
    for(int offset=0;offset<items.size();offset+=24){
      List<Map<String,Object>> batch=items.subList(offset,Math.min(offset+24,items.size()));
      Map<Path,BufferedImage> captures=new LinkedHashMap<>();
      game(()->{for(Map<String,Object> item:batch){Path file=out.resolve(item.get("icon").toString());if(Files.exists(file)&&!overwrite){count[0]++;continue;}
        try{captures.put(file,render(stack(item)));modes.put(item.get("id").toString(),"Botania:cocoon".equals(item.get("registryId"))?"runtime-model-neutral-pose":usedVanillaFallback?"vanilla-inventory-fallback":"forge-inventory-render");}
        catch(Throwable e){errors.add(Map.of("itemId",item.get("id"),"error",RuntimeDump.err(e)));}
      }});
      for(var e:captures.entrySet()){ImageIO.write(e.getValue(),"PNG",e.getKey().toFile());count[0]++;}
      write("sprites-progress.json",Map.of("rendered",count[0],"total",items.size(),"errors",errors.size()));
      if(!errors.isEmpty())write("sprites-errors.json",errors);
    }
    game(()->call(fbo,"func_147608_a"));write("icon-render-modes.json",modes);write("sprites-errors.json",errors);write("sprites-progress.json",Map.of("done",true,"rendered",count[0],"total",items.size(),"errors",errors.size()));
  }
}
