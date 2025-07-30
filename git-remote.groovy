import groovy.io.FileType
import java.nio.file.Paths

def args = getProperty("args") as String[]
def ant = new AntBuilder()

def baseDir = new File(args.length > 0 ? args[0] : ".").canonicalFile
println "Searching in $baseDir"
def sout = new StringBuilder()
def serr = new StringBuilder()
baseDir.eachFile (FileType.DIRECTORIES,  {
		println("Processing " + it)
		def status = ""
		def remoteUrl = ""
		def isDirty = false
		def hasLocalBranches = false
		def isGit = false

		if (System.properties['os.name'].toLowerCase().contains('windows')) {
			status = "cmd /c git -C $it status".execute()
			status.consumeProcessOutput(sout, serr)
			status.waitForOrKill(1000)
			isGit = !( sout.toString().contains("not a git repository") || serr.toString().contains("not a git repository") )
			sout.setLength(0);
			serr.setLength(0);
			println "isGit:" + isGit
			if (isGit) {
				remoteUrl = "cmd /c git -C $it remote -v".execute().text
				println remoteUrl
			}
		} else {
			status = "git -C $it remote -v".execute().text
			if (!status.contains("not a git repository")) {
				branches = "git -C $it branch".execute().text
				hasLocalBranches = branches.split('\n').length > 1
				isDirty = !"git -C $it diff --stat".execute().text.trim().isEmpty()
			}
		}
		
    }
)