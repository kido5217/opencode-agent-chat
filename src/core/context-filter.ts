export class ContextFilter {
  private readonly ids = new Set<string>();

  constructor(private readonly cap = 1000) {}

  note(id: string): void {
    if (id.length === 0) return;
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.cap) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  filter<Item extends { id: string }>(items: Item[]): Item[] {
    return items.filter((item) => !this.ids.has(item.id));
  }
}
