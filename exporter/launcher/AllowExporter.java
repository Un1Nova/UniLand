package atlas.launcher;
import java.io.File;
import java.util.*;
/** Preserve exactly the local TMR exporter; all other verification is unchanged. */
public final class AllowExporter {
  public static String classPath(String original) {
    String replacement=System.getProperty("uniland.loaderJar");
    if(replacement==null)return original;
    if(!new File(replacement).isFile())throw new IllegalStateException("Diagnostic loader JAR is missing");
    // Keep the launcher's original classpath intact; prefer the compatible copy.
    return replacement+File.pathSeparator+original;
  }
  public static List<String> jvm(List<String> arguments) {
    String agent=System.getProperty("uniland.agent");
    if(agent==null||agent.isBlank())return arguments;
    List<String> result=new ArrayList<>(arguments);
    result.add("-javaagent:"+agent);
    return result;
  }
  public static List<File> filter(List<File> files) {
    List<File> result=new ArrayList<>();
    for(File file:files) {
      String path=file.getAbsolutePath().replace('\\','/');
      if(!path.endsWith("/clients/techno_magic_rpg/main/mods/uniland-exporter-bootstrap.jar"))result.add(file);
    }
    return result;
  }
}
