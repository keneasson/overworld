// Overworld's store API (SYNC-14). Everything that saves reaches a store only through this interface,
// so sync (api/sync.mjs) works the same for any store that implements it. GitHub is the first
// (api/stores/github/); another tracker sits behind the same interface later.
//
// A store is one project's place in one store, made by `forProject(project)`. Items in it are named by
// a `ref`, a string only the store understands. A version of an item is { title, markdown, state }:
// the text is Overworld's, and `state` is the item's state in the store's own terms, opaque to sync.
//
//   key                              where the project lives, e.g. 'github:octo/shop'; links projects to events
//   writeBudget                      { perMinute, perHour }: writes sync keeps to, well under the store's limits
//   refOf(node)        -> ref|null   the item a node stands for, or null for one not in the store yet
//   nodeIdOf(ref)      -> string     the map node that stands for an item
//   mention(ref)       -> string     how another item's text refers to it
//   wanted(node)       -> version    what the store should hold for a node, state included (SYNC-08)
//   asRead(node)       -> version    what the store held when the map last read the node
//   same(a, b)         -> boolean    two versions read the same in the store
//   read(ref)          -> item       the item as the store holds it now (opaque)
//   version(item)      -> version
//   create(version, { guard, epic }) -> { ref }   guard: a token the store keeps out of sight on the new item
//   findCreated(guard, since)  -> { ref } | null  the item a create left behind, if it got there before a crash
//   carriesGuard(item, guard)  -> boolean
//   update(ref, item, version)       write `version` over `item`, sending only what differs; the guard goes
//   placed(node, ref)  -> node       a node made in Overworld, now that it is this item
//   onMap(node, item)  -> node       the node showing the store's version, keeping its place on the map
//   mapAgain({ token })-> { nodes, project }   the whole project read again, and fields for the project
//
// Reads and writes throw TransientError (try later) or PermanentError (a person must look): see errors.mjs.
//
// A store's events about its items arrive normalised, for sync.onEvents(key, events):
//   { type: 'changed', ref, item }   an item was edited in the store
//   { type: 'started', ref }         work on an item has started there (a pull request that closes it)

import { githubStore } from './github/index.mjs';

/**
 * @param {object} o
 * @param {object} [o.githubApp] the GitHub App client (stores/github/app.mjs); without it, GitHub can be read but not written
 */
export function createStores({ githubApp = null, fetchImpl = fetch } = {}) {
  return {
    /** The project's store, or null for a project that lives only in Overworld. */
    forProject(project) {
      if (project?.githubRepo) return githubStore({ repo: project.githubRepo, strict: project.strictLifecycle !== false, app: githubApp, fetchImpl });
      return null;
    },
  };
}
