import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import {
  createPoliceCourse, deletePoliceCourse, getGuildLiveOptions, getPoliceCoursesDashboard,
  publishPoliceCourse, savePoliceCourseConfig, updatePoliceCourse, uploadPoliceCourseBanner
} from "../../lib/api";
import { createDashboardSocket } from "../../lib/socket";
import type { DashboardGuild, GuildChannelOption, PoliceCourse, PoliceCourseConfig } from "../../types";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";

type Props = { botId: string | null; canManage: boolean; guild: DashboardGuild };
type Draft = { id?: string; courseNumber: string; title: string; instructorName: string; date: string; time: string; location: string; maxSlots: string; description: string; notes: string; bannerUrl?: string | null };
const emptyDraft: Draft = { courseNumber: "", title: "", instructorName: "", date: "", time: "", location: "", maxSlots: "", description: "", notes: "" };

export function PoliceCoursesPanel({ botId, canManage, guild }: Props) {
  const [config, setConfig] = useState<PoliceCourseConfig | null>(null);
  const [courses, setCourses] = useState<PoliceCourse[]>([]);
  const [channels, setChannels] = useState<GuildChannelOption[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [banner, setBanner] = useState<File | null>(null);
  const [publishChannels, setPublishChannels] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  async function load() {
    if (!botId) return;
    const [dashboard, options] = await Promise.all([getPoliceCoursesDashboard(guild.id, botId), getGuildLiveOptions(guild.id, botId)]);
    setConfig(dashboard.config);
    setCourses(dashboard.courses);
    setChannels(options.channels.filter((channel) => channel.type === "text" || channel.type === "announcement"));
  }

  useEffect(() => { void load().catch(() => setMessage("Nao foi possivel carregar os cursos.")); }, [botId, guild.id]);
  useEffect(() => {
    const socket = createDashboardSocket();
    const refresh = (payload: { botId?: string; guildId?: string }) => {
      if (payload.guildId === guild.id && (!payload.botId || payload.botId === botId)) void load();
    };
    socket.on("police-courses:updated", refresh);
    return () => { socket.off("police-courses:updated", refresh); socket.disconnect(); };
  }, [botId, guild.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!botId || !canManage) return;
    try {
      const payload = { ...draft, maxSlots: draft.maxSlots ? Number(draft.maxSlots) : null };
      let saved = draft.id ? await updatePoliceCourse(guild.id, botId, draft.id, payload) : await createPoliceCourse(guild.id, botId, payload);
      if (banner) saved = await uploadPoliceCourseBanner(guild.id, botId, saved.id, banner);
      setCourses((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setDraft(emptyDraft); setBanner(null); setEditing(false); setMessage("Curso salvo.");
    } catch (error: any) { setMessage(error?.response?.data?.message || "Nao foi possivel salvar o curso."); }
  }

  async function patchConfig(patch: Partial<PoliceCourseConfig>) {
    if (!botId || !config || !canManage) return;
    const previous = config; setConfig({ ...config, ...patch });
    try { setConfig(await savePoliceCourseConfig(guild.id, botId, patch)); } catch { setConfig(previous); }
  }

  if (!botId || !config) return <Card><CardContent className="p-6">Carregando cursos...</CardContent></Card>;
  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Cursos / Treinamentos</h1><p className="text-sm text-muted-foreground">Cadastro, publicacao e participantes dos cursos policiais.</p></div>
      <Button disabled={!canManage} onClick={() => { setDraft(emptyDraft); setEditing(true); }}><Plus className="mr-2 h-4 w-4" />Novo curso</Button>
    </div>
    {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
    {editing ? <Card><CardHeader><CardTitle>{draft.id ? "Editar curso" : "Cadastrar curso"}</CardTitle><CardDescription>O painel publicado sera atualizado automaticamente.</CardDescription></CardHeader><CardContent>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
        <Field label="Numero" value={draft.courseNumber} onChange={(courseNumber) => setDraft({ ...draft, courseNumber })} required />
        <Field label="Nome" value={draft.title} onChange={(title) => setDraft({ ...draft, title })} required />
        <Field label="Instrutor" value={draft.instructorName} onChange={(instructorName) => setDraft({ ...draft, instructorName })} />
        <Field label="Data" value={draft.date} onChange={(date) => setDraft({ ...draft, date })} />
        <Field label="Horario" value={draft.time} onChange={(time) => setDraft({ ...draft, time })} />
        <Field label="Local" value={draft.location} onChange={(location) => setDraft({ ...draft, location })} />
        <Field label="Limite de vagas" type="number" value={draft.maxSlots} onChange={(maxSlots) => setDraft({ ...draft, maxSlots })} />
        <label className="space-y-2 text-sm"><span>Upload de banner</span><input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          if (file && file.size > 8 * 1024 * 1024) return setMessage("O banner deve ter no maximo 8 MB.");
          setBanner(file);
        }} /></label>
        <label className="space-y-2 text-sm md:col-span-2"><span>Descricao</span><textarea className="min-h-24 w-full rounded-md border bg-background p-3" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="space-y-2 text-sm md:col-span-2"><span>Observacoes</span><textarea className="min-h-20 w-full rounded-md border bg-background p-3" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
        {(banner || draft.bannerUrl) ? <img className="max-h-72 w-full border object-cover md:col-span-2" src={banner ? URL.createObjectURL(banner) : draft.bannerUrl || ""} alt="Previa do banner" /> : null}
        <div className="flex gap-2 md:col-span-2"><Button type="submit">Salvar</Button><Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancelar</Button></div>
      </form>
    </CardContent></Card> : null}
    <Card><CardHeader><CardTitle>Configuracao geral</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">
      <Toggle label="Sistema ativo" value={config.enabled} change={(enabled) => void patchConfig({ enabled })} />
      <Toggle label="DM ao finalizar" value={config.dmOnFinish} change={(dmOnFinish) => void patchConfig({ dmOnFinish })} />
      <Toggle label="DM ao cancelar" value={config.dmOnCancel} change={(dmOnCancel) => void patchConfig({ dmOnCancel })} />
      <Toggle label="Bloquear canal ao finalizar" value={config.lockChannelOnFinish} change={(lockChannelOnFinish) => void patchConfig({ lockChannelOnFinish })} />
      <Toggle label="Bloquear canal ao cancelar" value={config.lockChannelOnCancel} change={(lockChannelOnCancel) => void patchConfig({ lockChannelOnCancel })} />
      <Toggle label="Apagar painel ao cancelar" value={config.deletePanelOnCancel} change={(deletePanelOnCancel) => void patchConfig({ deletePanelOnCancel })} />
      <Channel label="Canal de logs" channels={channels} value={config.logChannelId || ""} change={(logChannelId) => void patchConfig({ logChannelId: logChannelId || null })} />
      <Channel label="Canal padrao" channels={channels} value={config.defaultPanelChannelId || ""} change={(defaultPanelChannelId) => void patchConfig({ defaultPanelChannelId: defaultPanelChannelId || null })} />
    </CardContent></Card>
    <div className="grid gap-4 xl:grid-cols-2">{courses.map((course) => <Card key={course.id}>
      {course.bannerUrl ? <img className="h-44 w-full object-cover" src={course.bannerUrl} alt="" /> : null}
      <CardHeader><CardTitle>{course.courseNumber} - {course.title}</CardTitle><CardDescription>{course.status} • {course.participants.length}{course.maxSlots ? `/${course.maxSlots}` : ""} inscritos</CardDescription></CardHeader>
      <CardContent className="space-y-4"><p className="text-sm">{course.date} as {course.time} • {course.location} • {course.instructorName}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => { setDraft({ ...course, maxSlots: course.maxSlots ? String(course.maxSlots) : "" }); setEditing(true); }}><Pencil className="mr-2 h-4 w-4" />Editar</Button>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={publishChannels[course.id] || config.defaultPanelChannelId || ""} onChange={(event) => setPublishChannels({ ...publishChannels, [course.id]: event.target.value })}><option value="">Canal</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select>
          <Button size="sm" onClick={async () => { await publishPoliceCourse(guild.id, botId, course.id, publishChannels[course.id] || config.defaultPanelChannelId); setMessage("Publicacao solicitada."); }}><Send className="mr-2 h-4 w-4" />Publicar</Button>
          <Button size="sm" variant="destructive" onClick={async () => { if (window.confirm("Excluir este curso?")) { await deletePoliceCourse(guild.id, botId, course.id); setCourses((items) => items.filter((item) => item.id !== course.id)); } }}><Trash2 className="mr-2 h-4 w-4" />Excluir</Button>
        </div>
      </CardContent>
    </Card>)}</div>
  </div>;
}

function Field({ label, value, onChange, required, type = "text" }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string }) { return <label className="space-y-2 text-sm"><span>{label}</span><input className="h-10 w-full rounded-md border bg-background px-3" type={type} value={value} required={required} onChange={(event) => onChange(event.target.value)} /></label>; }
function Toggle({ label, value, change }: { label: string; value: boolean; change: (value: boolean) => void }) { return <label className="flex items-center justify-between border p-3 text-sm"><span>{label}</span><Switch checked={value} onCheckedChange={change} /></label>; }
function Channel({ label, channels, value, change }: { label: string; channels: GuildChannelOption[]; value: string; change: (value: string) => void }) { return <label className="space-y-2 text-sm"><span>{label}</span><select className="h-10 w-full rounded-md border bg-background px-3" value={value} onChange={(event) => change(event.target.value)}><option value="">Nao configurado</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>; }
