import * as fs from 'fs';
import * as zlib from 'zlib'
import * as readline from 'readline'

function readFile(path) {
    let stream = fs.createReadStream(path)
    
    if(/\.gz$/i.test(path)) {
        stream = stream.pipe(zlib.createGunzip())
    }
    return readline.createInterface({
        input: stream,
        crlfDelay: Infinity
    })
}

async function main() {
    const lineReader = readFile('/path/to/msgs/msgs-2k.gz')
    for await(const line of lineReader) {
        console.log(line)
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1)
})