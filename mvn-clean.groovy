import groovy.io.FileType
import java.nio.file.Paths

def args = getProperty("args") as String[]


def baseDir = new File(args.length > 0 ? args[0] : ".").canonicalFile
println "Searching in $baseDir"
baseDir.eachFile (FileType.DIRECTORIES,  {
        def target = Paths.get(it.getAbsolutePath(), "target").toFile()
        println(it.toString() + " " + target)
        if(target.exists()) {
            println("Cleaning " + it)
			if (System.properties['os.name'].toLowerCase().contains('windows'))
				print "cmd /c mvn -f $it clean".execute().text
			else
				print "mvn -f $it clean".execute().text
        }
    }
)