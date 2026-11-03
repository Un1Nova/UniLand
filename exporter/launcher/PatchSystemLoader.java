import org.objectweb.asm.*;
import java.nio.file.*;
import java.util.jar.*;
public class PatchSystemLoader {
  public static void main(String[] args)throws Exception {
    Path source=Path.of(args[0]),outPath=Path.of(args[1]);
    if(Files.exists(outPath))throw new IllegalArgumentException("Use a new output file");
    int[] matches={0};
    try(JarFile in=new JarFile(source.toFile());JarOutputStream out=new JarOutputStream(Files.newOutputStream(outPath,StandardOpenOption.CREATE_NEW))){
      var entries=in.entries();
      while(entries.hasMoreElements()){
        JarEntry entry=entries.nextElement();byte[] data=in.getInputStream(entry).readAllBytes();
        if(entry.getName().equals("net/minecraft/launchwrapper/compat/LaunchSystemClassLoader.class")){
          ClassReader reader=new ClassReader(data);ClassWriter writer=new ClassWriter(0);
          reader.accept(new ClassVisitor(Opcodes.ASM9,writer){
            public MethodVisitor visitMethod(int a,String n,String d,String s,String[] e){
              if(n.equals("appendToClassPathForInstrumentation"))throw new IllegalStateException("Already supported");
              return super.visitMethod(a,n,d,s,e);
            }
            public void visitEnd(){
              MethodVisitor m=super.visitMethod(Opcodes.ACC_PUBLIC,"appendToClassPathForInstrumentation","(Ljava/lang/String;)V",null,new String[]{"java/net/MalformedURLException"});
              m.visitCode();m.visitVarInsn(Opcodes.ALOAD,0);m.visitTypeInsn(Opcodes.NEW,"java/io/File");m.visitInsn(Opcodes.DUP);m.visitVarInsn(Opcodes.ALOAD,1);
              m.visitMethodInsn(Opcodes.INVOKESPECIAL,"java/io/File","<init>","(Ljava/lang/String;)V",false);
              m.visitMethodInsn(Opcodes.INVOKEVIRTUAL,"java/io/File","toURI","()Ljava/net/URI;",false);
              m.visitMethodInsn(Opcodes.INVOKEVIRTUAL,"java/net/URI","toURL","()Ljava/net/URL;",false);
              m.visitMethodInsn(Opcodes.INVOKEVIRTUAL,"net/minecraft/launchwrapper/compat/URLClassLoaderBase","addURL","(Ljava/net/URL;)V",false);
              m.visitInsn(Opcodes.RETURN);m.visitMaxs(4,2);m.visitEnd();matches[0]++;super.visitEnd();
            }
          },0);data=writer.toByteArray();
        }
        JarEntry copy=new JarEntry(entry.getName());copy.setTime(entry.getTime());out.putNextEntry(copy);out.write(data);out.closeEntry();
      }
    }
    if(matches[0]!=1)throw new IllegalStateException("Unexpected class count");
    System.out.println("Added standard instrumentation append method to one loader class.");
  }
}
