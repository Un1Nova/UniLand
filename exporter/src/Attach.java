import com.sun.tools.attach.VirtualMachine;
public class Attach {
  public static void main(String[] args) throws Exception {
    if (args.length != 3) throw new IllegalArgumentException("PID agent.jar output-directory");
    VirtualMachine vm = VirtualMachine.attach(args[0]);
    try { vm.loadAgent(args[1], args[2]); } finally { vm.detach(); }
  }
}
