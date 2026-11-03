import { Context, Service } from '@deepseek-ai/cordis'
import { Entry, type EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const existing = this.tree.store[id]
    const container = this.ctx.fiber.entry
    if (existing && container && existing.contains(container)) {
      throw new TypeError(
        `loader entry id ${id} (${options.name}) would adopt its containing entry ${container.id}:`
        + ' a nested row must not reuse the id of a group row containing it',
      )
    }
    const entry: Entry = existing ?? (this.tree.store[id] = new Entry(this.ctx.loader))
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    await entry.update(options, true, true)
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry || entry.parent !== this) return
    // Unregister before disposal so Loader can distinguish removal from self-disposal.
    delete this.tree.store[id]
    entry.fiber?.dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    // The store keys entries by raw row id, so one id must be unique across
    // the whole incoming tree, not just one list: a nested row reusing an
    // ancestor group row's id would adopt that entry when created and cycle
    // its parent chain. Rows whose id matches a same-store containing entry
    // are rejected for the same reason — adoption is only impossible from
    // outside this tree's store (an include boundary). Validation runs before
    // any entry is created or adopted, so the rejection cannot strand a
    // half-applied tree.
    const seen = new Set<string>()
    const containerIds = new Set<string>()
    let owner = this.ctx.fiber.entry
    while (owner) {
      if (owner.parent.tree === this.tree) containerIds.add(owner.options.id)
      owner = owner.parent.ctx.fiber.entry
    }
    const validate = (rows: EntryOptions[]) => {
      for (const options of rows) {
        const id = this.tree.ensureId(options)
        if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`)
        if (containerIds.has(id)) throw new TypeError(`loader entry id ${id} collides with its containing entry`)
        seen.add(id)
        if (options.group && Array.isArray(options.config)) validate(options.config as EntryOptions[])
      }
    }
    validate(config)
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    await Promise.all(ids.map(async (id) => {
      if (newMap[id]) {
        await this.create(newMap[id]).catch((error) => {
          this.ctx.logger.error(error)
        })
      } else {
        this.remove(id)
      }
    }))
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id, true)
    }
  }
}

/** Plugin that mounts a nested loader entry group. */
export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.fiber.entry!.parent.tree)
    ctx.on('internal/update', config => this.update(config))
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
