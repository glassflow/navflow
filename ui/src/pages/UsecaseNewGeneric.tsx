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

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? "copied" : "copy"}
    </button>
  );
}

export default function UsecaseNewGeneric() {
  const { recipe: key = "" } = useParams();
  const navigate = useNavigate();
  const [recipe, setRecipe] = useState<Recipe>();
  const [err, setErr] = useState<string>();
  const [name, setName] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ configured: boolean; source: string }>();
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyErr, setKeyErr] = useState<string>();
  const loadKey = () => api.anthropicKeyStatus().then((k) => setKeyStatus(k)).catch(() => setKeyStatus(undefined));
  const saveKey = async () => {
    setKeyBusy(true); setKeyErr(undefined);
    try { await api.setAnthropicKey(keyInput.trim()); setKeyInput(""); await loadKey(); }
    catch (e) { setKeyErr(String((e as Error).message ?? e)); }
    setKeyBusy(false);
  };

  useEffect(() => {
    loadKey();
    api.builtinAgents().then((r) => { setModels(r.models); setDefaultModel(r.default_model); }).catch(() => {});
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
      {recipe && recipe.setup && recipe.setup.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Before you start</h2>
          <ol className="uc-setup">
            {recipe.setup.map((st, i) => {
              const keyStep = st.check === "anthropic_key";
              const done = keyStep && keyStatus?.configured;
              return (
              <li key={i} className={done ? "uc-setup-done" : undefined}>
                <div className="uc-setup-title">
                  {st.title}
                  {done && <span className="badge ok" style={{ marginLeft: 8 }}>done</span>}
                </div>
                {done ? (
                  <p className="help" style={{ margin: "2px 0 0" }}>
                    an Anthropic key is set{keyStatus?.source ? ` (${keyStatus.source})` : ""}; the agent can run. Change it under Settings.
                  </p>
                ) : (
                  <>
                    {st.text && <p className="help" style={{ margin: "2px 0 6px" }}>{st.text}</p>}
                    {keyStep && (
                      <div className="btnrow" style={{ alignItems: "center", maxWidth: 640 }}>
                        <input type="password" className="mono" style={{ flex: 1 }} autoComplete="new-password" data-1p-ignore data-lpignore="true"
                               placeholder="sk-ant-..." value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
                        <button className="primary" disabled={keyBusy || !keyInput.trim()} onClick={saveKey}>{keyBusy ? "saving..." : "Save key"}</button>
                        {keyErr && <span className="help" style={{ color: "var(--err)" }}>{keyErr}</span>}
                      </div>
                    )}
                  </>
                )}
                {st.command && (
                  <div className="uc-setup-cmd">
                    <pre className="mono">{st.command}</pre>
                    <CopyBtn text={st.command} />
                  </div>
                )}
              </li>
              );
            })}
          </ol>
        </div>
      )}
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
              ) : k === "model" ? (
                <Picker value={vals[k] ?? ""} onChange={(v) => setVals({ ...vals, [k]: v })}
                        options={["", ...models.filter((m) => m !== defaultModel)]}
                        labels={{ "": defaultModel ? `${defaultModel} · instance default` : "instance default" }}
                        ariaLabel="model" />
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
