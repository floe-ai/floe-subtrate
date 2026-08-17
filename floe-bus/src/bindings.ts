/**
 * Bindings — the generic mechanism by which a primitive (an actor, or a Scope
 * Graph node) is given material that shapes its behaviour, without that
 * material being welded into the primitive's own structure.
 *
 * Resolved on https://github.com/floe-ai/floe-subtrate/issues/142: an actor
 * is an identifier, a label, and an ordered list of bindings (that ticket
 * used the word "attachment"; the operator renamed the concept to "binding"
 * since "attachment" already means a bridge attaching a workspace). A binding
 * is typed by `kind`; the substrate carries and orders bindings generically
 * and does not know what any kind means — meaning lives with the kind.
 *
 * `instructions` is the first kind implemented: free-form text, resolved
 * inline (no external ref/version/hash — the text itself IS the material,
 * there is nothing outside the binding to point at). Other kinds (`role`,
 * pointing at a centrally-stored, versioned bundle; `schema`; `image`) can
 * extend this union later without touching whatever holds the list.
 */
export type InstructionsBinding = {
  kind: "instructions";
  text: string;
};

export type Binding = InstructionsBinding;
