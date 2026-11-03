import org.objectweb.asm.*;
import java.nio.file.*;
import java.util.jar.*;
import java.io.*;
public class PatchLauncher {
  public static void main(String[] args) throws Exception {
    if(args.length!=3)throw new IllegalArgumentException("original.jar output.jar helper.class");
    Path source=Path.of(args[0]),output=Path.of(args[1]);
    if(source.toRealPath().equals(output.toAbsolutePath().normalize())||Files.exists(output))throw new IllegalArgumentException("Output must be a new separate file");
    int[] matches={0};
    try(JarFile in=new JarFile(source.toFile());JarOutputStream out=new JarOutputStream(Files.newOutputStream(output,StandardOpenOption.CREATE_NEW))) {
      var entries=in.entries();
      while(entries.hasMoreElements()) {
        JarEntry entry=entries.nextElement();
        if(entry.getName().matches("META-INF/.*\\.(SF|RSA|DSA|EC)"))throw new IllegalArgumentException("Signed launcher: unsupported");
        byte[] data=in.getInputStream(entry).readAllBytes();
        if(entry.getName().equals("loliland/launcher/app/data/ClientResourceSync.class")||entry.getName().equals("loliland/launcher/app/data/ClientLaunchConfig.class")||entry.getName().equals("loliland/launcher/app/obf/l0illAND.class")) {
          ClassReader reader=new ClassReader(data);ClassWriter writer=new ClassWriter(0);
          reader.accept(new ClassVisitor(Opcodes.ASM9,writer) {
            public MethodVisitor visitMethod(int access,String name,String desc,String signature,String[] exceptions) {
              MethodVisitor original=super.visitMethod(access,name,desc,signature,exceptions);
              if(name.equals("I1O1I1LaNd")&&desc.equals("(Lloliland/launcher/app/data/ClientLaunchConfig;Ljava/io/File;)Ljava/lang/String;")) {
                matches[0]++;
                return new MethodVisitor(Opcodes.ASM9,original) {
                  public void visitInsn(int opcode) {
                    if(opcode==Opcodes.ARETURN)super.visitMethodInsn(Opcodes.INVOKESTATIC,"atlas/launcher/AllowExporter","classPath","(Ljava/lang/String;)Ljava/lang/String;",false);
                    super.visitInsn(opcode);
                  }
                };
              }
              if((!name.equals("getFilesToDelete")&&!name.equals("getJvmArguments"))||!desc.equals("()Ljava/util/List;"))return original;
              matches[0]++;
              return new MethodVisitor(Opcodes.ASM9,original) {
                public void visitInsn(int opcode) {
                  if(opcode==Opcodes.ARETURN)super.visitMethodInsn(Opcodes.INVOKESTATIC,"atlas/launcher/AllowExporter",name.equals("getFilesToDelete")?"filter":"jvm","(Ljava/util/List;)Ljava/util/List;",false);
                  super.visitInsn(opcode);
                }
              };
            }
          },0);
          data=writer.toByteArray();
        }
        JarEntry copy=new JarEntry(entry.getName());copy.setTime(entry.getTime());
        out.putNextEntry(copy);out.write(data);out.closeEntry();
      }
      out.putNextEntry(new JarEntry("atlas/launcher/AllowExporter.class"));
      out.write(Files.readAllBytes(Path.of(args[2])));out.closeEntry();
    }
    if(matches[0]!=3)throw new IllegalStateException("Expected exactly three methods; found "+matches[0]);
    System.out.println("Patched deletion-list, JVM-options, and launchwrapper path; authentication is unchanged.");
  }
}
