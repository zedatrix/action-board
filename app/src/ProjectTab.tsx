import { project } from "./data/project";
import { PROJECT_COLUMNS, projectTotals, zonedTime } from "./project";

// The project tab: one row per milestone from data/project.ts, plus a summed "All milestones" row.
// Only components are exported, so a project.ts edit hot-reloads this tab without re-running App.
export function ProjectTab() {
  const { title, milestones, parent, updated_at } = project;
  const totals = projectTotals(milestones);
  return (
    <main className="project">
      <h2 className="kicker">
        {title} <span className="n">{milestones.length}</span>
      </h2>
      <p className="project-note">
        Left includes in progress. Duplicate and canceled tickets excluded.
        <br />
        Last updated <time dateTime={updated_at}>{zonedTime(updated_at)}</time>
        {" · "}
        <a href={parent.url} target="_blank" rel="noopener">
          {parent.id}
        </a>
      </p>
      <div className="project-wrap">
        <table className="project-table">
          <thead>
            <tr>
              <th scope="col">Milestone</th>
              {PROJECT_COLUMNS.map((c) => (
                <th scope="col" className="num" key={c.key}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {milestones.map((m) => (
              <tr key={m.id}>
                <th scope="row">
                  <a href={m.url} target="_blank" rel="noopener">
                    <span className="project-name">
                      {m.key} {m.title}
                    </span>
                    <span className="project-id">{m.id}</span>
                  </a>
                </th>
                {PROJECT_COLUMNS.map((c) => (
                  <td className="num" key={c.key}>
                    {m[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="project-total">
              <th scope="row">All milestones</th>
              {PROJECT_COLUMNS.map((c) => (
                <td className="num" key={c.key}>
                  {totals[c.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </main>
  );
}

// The tab's label in the tab bar: the project's title.
export function ProjectTabLabel() {
  return <>{project.title}</>;
}
