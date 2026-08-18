import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../api";
import { Picker } from "../components/bits";
import type { Recipe, RecipeParam } from "../types";

// The fallback wizard: a form rendered straight from a recipe's PARAMS, for recipes without a
// dedicated flow. Strings, numbers, booleans and choices get inputs; lists and objects are JSON.

function initial(p: RecipeParam): string {
  if (p.default == null) return p.type === "bool" ? "false" : "";
  return typeof p.default === "string" ? p.default : JSON.stringify(p.default);
}

export default function UsecaseNewGeneric() {
  const { recipe: key = "" } = useParams();
  const navigate = useNavigate();
  const [recipe, setRecipe] = useState<Recipe>();
  const [err, setErr] = useState<string>();
  const [name, setName] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.recipes().then((r) => {
      const found = r.recipes.find((x) => x.key === key);
      if (!found) { setErr(`this instance has no use case named ${key}`); return; }
      setRecipe(found);
      setName(found.title);
      setVals(Object.fromEntries(Object.entries(found.params).map(([k, p]) => [k, initial(p)])));
    }).catch((e) => setErr(String((e as Error).message ?? e)));
  }, [key]);

  const submit = async () => {
    if (!recipe) return;
    setBusy(true); setErr(undefined);
    const params: Record<string, unknown> = {};
    try {
      for (const [k, p] of Object.entries(recipe.params)) {
        const v = vals[k] ?? "";
        if (v === "" && !p.required) continue;
        if (p.type === "number") params[k] = Number(v);
        else if (p.type === "bool") params[k] = v === "true";
        else if (p.type === "list" || p.type === "json") params[k] = v ? JSON.parse(v) : undefined;
        else params[k] = v;
      }
      const u = await api.createUsecase({ recipe: recipe.key, name: name.trim() || undefined, params });
      navigate(`/usecases/${encodeURIComponent(u.id)}`, { replace: true });
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{recipe?.title ?? key}</h1>
          <p className="subtitle">{recipe?.description}</p>
        </div>
      </div>
      {err && <div className="alert error">{err}</div>}
      {recipe && (
        <div className="panel">
          <label className="field">
            <span className="lbl">name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {Object.entries(recipe.params).map(([k, p]) => (
            <label className="field" key={k}>
              <span className="lbl">{p.label ?? k}{p.required && <span className="req"> *</span>}</span>
              {p.type === "bool" ? (
                <Picker value={vals[k] ?? "false"} onChange={(v) => setVals({ ...vals, [k]: v })}
                        options={["true", "false"]} ariaLabel={k} />
              ) : p.choices?.length ? (
                <Picker value={vals[k] ?? ""} onChange={(v) => setVals({ ...vals, [k]: v })}
                        options={p.choices} ariaLabel={k} />
              ) : p.type === "list" || p.type === "json" ? (
                <textarea className="mono" rows={4} value={vals[k] ?? ""}
                          onChange={(e) => setVals({ ...vals, [k]: e.target.value })} placeholder="JSON" />
              ) : (
                <input type={p.type === "number" ? "number" : "text"} className="mono" value={vals[k] ?? ""}
                       onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
              )}
              {p.help && <span className="help">{p.help}</span>}
            </label>
          ))}
          <div className="btnrow">
            <button className="primary" disabled={busy} onClick={submit}>{busy ? "starting…" : "Start"}</button>
            <Link className="btn" to="/usecases">Cancel</Link>
          </div>
        </div>
      )}
    </>
  );
}
