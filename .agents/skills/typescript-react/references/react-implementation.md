# React implementation

Apply only to touched React components/hooks. JavaScript React follows implementation conventions without inheriting TypeScript typing preferences. Repository facts and the established surrounding style win. For imports, exports and options objects, read only [Shared implementation conventions](typescript-idioms.md#shared-implementation-conventions); TypeScript-specific preferences apply only to TypeScript code.

## Component structure

```typescript
import { useState } from "react";

import { Button, TextField } from "../../components";
import { useProject } from "../hooks";
import style from "./style/ProjectForm.module.scss";

type Props = {
    onSave: (name: string) => void;
    projectId: string;
};

export function ProjectForm({ onSave, projectId }: Props) {
    const { data: project } = useProject(projectId);
    const [name, setName] = useState("");

    const handleSave = () => {
        onSave(name);
    };

    return (
        <div className={style.root}>
            <h2>{project?.name}</h2>
            <TextField label="Name" onChange={setName} value={name} />
            <Button onClick={handleSave}>Save</Button>
        </div>
    );
}
```

- Inside a component: hooks, then handlers, then render.
- Keep rendering in components. Put reusable computation at the narrowest scope that uses it; follow `ownership-boundaries` when the task changes contracts or ownership.

## Callbacks and hooks

```typescript
// Destructure when only named fields are read
getText: ({ answer }) => answer ?? ""

// Destructure a hook's return when the object is not used as a whole
const { items, setItems } = useItemsStore();

// Rename at the source instead of adding an alias
const { data: models = [] } = useModels();
```

- Use `useCallback` or `useMemo` only when a measured cost, a dependency array or a memoized child needs a stable value.
- Collection and entity handlers take the full updated value (`onChange`), not a set of `onAdd` and `onDelete` callbacks.

## Components and UI

- Reuse ladder, climbed in order: the repository's UI library if it has one, then its shared components, then the feature's components. Do not add a wrapper when an earlier rung already covers the need.
- Use a dedicated component over a raw `<button>`, `<input>`, `<select>` or `<a>`. When it cannot do the job, say why.
- Before inventing props or styles, read the component's type definitions and use its built-in props, such as variant, size or spacing. No inline styles. For stylesheets, classes and tokens, use the `css-authoring-conventions` skill when it is installed.
- Async views expose the states the product can meaningfully distinguish; use `async-state` for uncertain or overlapping workflows.
- List keys are stable, never the array index when items can be reordered, inserted or removed. Virtualize or paginate lists that can grow into the hundreds.

Keep meaningful touched states usable with long/localized text and content growth. Preserve entered values on recoverable errors and check paste/autofill when the input flow changes. Keep effects that synchronize external systems correctly owned and cleaned up; derive values directly where no synchronization is needed. Detailed performance work uses [client performance](client-performance.md) only for a concrete issue or request. Apply the selected basic accessibility baseline; use web-accessibility when installed and its scope applies.
