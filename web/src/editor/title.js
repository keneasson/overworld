// An item is never untitled (#41 EDIT-22). A new item's "New task" works like an input's placeholder: the box opens empty,
// waiting for a title, with "New task" shown faintly; a title left empty is saved as the one it stands in for. For an
// item that already has a title, the title it opened with stands in, so a title cleared and abandoned comes back.

/** What the title box shows when it opens: empty for a new item still called by its placeholder, else the title. */
export const titleShown = (title, placeholder) => (placeholder && title === placeholder ? '' : title);

/** The title an edit carries: what was typed, or the stand-in when nothing is, so a save never sends an empty title. */
export const titleToSave = (typed, standIn) => (typed.trim() ? typed : standIn);
