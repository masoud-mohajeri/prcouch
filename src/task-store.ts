export type Task = {
  id: string;
  title: string;
  dueDate?: string;
  completed: boolean;
};

export class TaskStore {
  private tasks: Task[] = [];
  private nextId = 1;

  add(title: string, dueDate?: string): Task {
    const task = { id: String(this.nextId++), title, dueDate, completed: false };
    this.tasks.push(task);
    return task;
  }

  list(includeCompleted = false): Task[] {
    return this.tasks.filter((task) => includeCompleted || !task.completed);
  }

  complete(id: string): Task | undefined {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (task) task.completed = true;
    return task;
  }
}
