export function notesKey(courseId: string) {
  return `notes:${courseId}`;
}
export function loadNotes(courseId: string) {
  return localStorage.getItem(notesKey(courseId)) || "";
}
export function saveNotes(courseId: string, text: string) {
  localStorage.setItem(notesKey(courseId), text);
}
