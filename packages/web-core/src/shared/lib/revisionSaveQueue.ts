export type RevisionSaveResult<T> = {
  value: T;
  revision: string;
  isLatest: boolean;
};

export class RevisionSaveQueue<T> {
  private tail: Promise<void> = Promise.resolve();
  private revision: string;
  private sequence = 0;
  private pending = 0;

  constructor(revision: string) {
    this.revision = revision;
  }

  syncRevision(revision: string): void {
    if (this.pending === 0) this.revision = revision;
  }

  enqueue(
    value: T,
    save: (value: T, revision: string) => Promise<string>
  ): Promise<RevisionSaveResult<T>> {
    const sequence = ++this.sequence;
    this.pending += 1;
    const task = this.tail.then(async () => {
      const revision = await save(value, this.revision);
      this.revision = revision;
      return { value, revision, isLatest: sequence === this.sequence };
    });
    this.tail = task.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      }
    );
    return task;
  }
}
