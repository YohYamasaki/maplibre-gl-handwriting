/**
 * Appends nodes in order. Node.appendChild rather than Element.append: the Worker types the tests compile with
 * declare an Element of their own (HTMLRewriter) whose append takes strings
 */
export function appendChildren(parent: Node, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child)
}
