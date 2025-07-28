import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

(async function processLineByLine() {
  try {
    const rl = createInterface({
      input: createReadStream('/mnt/c/msgs/msgs-10k'),
      crlfDelay: Infinity,
    });
	let lineCount = 0;
    rl.on('line', (line) => {
      //console.log(line);
	    lineCount++;
    });

    await once(rl, 'close');

    console.log(lineCount);
  } catch (err) {
    console.error(err);
  }
})();