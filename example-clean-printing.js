const { EventEmitter } = require('events');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Create a global event emitter to manage communication
const progressEmitter = new EventEmitter();

// Task function that emits progress updates
async function taskWithProgress(taskName, duration, taskId) {
  const steps = 10;
  let progress = 0;

  for (let i = 1; i <= steps; i++) {
    await delay(duration / steps); // Simulate work being done
    progress = (i / steps) * 100;

    // Emit progress update to the main process
    progressEmitter.emit('progress', { taskId, taskName, progress });
  }

  // Final update when the task is complete
  progressEmitter.emit('progress', { taskId, taskName, progress: 100 });
}

// Main function to run the tasks and handle progress updates
async function runTasks() {
  // Listen for progress updates and print them
  const progressMap = {};

  progressEmitter.on('progress', ({ taskId, taskName, progress }) => {
    // Update the progress for the specific task
    if (!progressMap[taskId]) {
      progressMap[taskId] = `${taskName}: [          ] 0%`;
    }

    const steps = 10;
    const filled = Math.floor((progress / 100) * steps);
    const empty = steps - filled;
    progressMap[taskId] = `${taskName}: [${'='.repeat(filled)}${' '.repeat(empty)}] ${Math.round(progress)}%`;

    // Print the updated progress for each task
    console.clear();
    Object.values(progressMap).forEach(line => {
      console.log(line);
    });
  });

  // Run tasks in parallel
  const tasks = [
    taskWithProgress("Task 1", 3000, 1),
    taskWithProgress("Task 2", 5000, 2),
    taskWithProgress("Task 3", 4000, 3)
  ];

  await Promise.all(tasks);
}

runTasks();
