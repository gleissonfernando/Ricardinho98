import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Pencil, Plus, Save, Trash2 } from "lucide-react";
import {
  createPoliceCourse, deletePoliceCourse, getGuildLiveOptions, getPoliceCoursesDashboard,
  getGuildMemberOptions, publishPoliceCourse, savePoliceCourseConfig, updatePoliceCourse, uploadPoliceCourseBanner
} from "../../lib/api";
import { createDashboardSocket } from "../../lib/socket";
import type { DashboardGuild, GuildChannelOption, GuildMemberOption, GuildRoleOption, PoliceCourse, PoliceCourseConfig } from "../../types";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";

type Props = { botId: string | null; canManage: boolean; guild: DashboardGuild };
type Draft = { id?: string; courseNumber: string; title: string; category: string | null; displayOrder: number; status: PoliceCourse["status"]; emoji: string | null; color: string | null; description: string; bannerUrl?: string | null; imagePosition: "top" | "thumbnail" | "bottom" | "none"; panelChannelId: string | null; authorizedRoleIds: string[]; authorizedUserIds: string[]; participantRoleIds: string[]; viewerRoleIds: string[] };
const emptyDraft: Draft = { courseNumber: "", title: "", category: null, displayOrder: 0, status: "draft", emoji: null, color: "#2563eb", description: "", imagePosition: "top", panelChannelId: null, authorizedRoleIds: [], authorizedUserIds: [], participantRoleIds: [], viewerRoleIds: [] };

export function PoliceCoursesPanel({ botId, canManage, guild }: Props) {
  const [config, setConfig] = useState<PoliceCourseConfig | null>(null);
  const [courses, setCourses] = useState<PoliceCourse[]>([]);
  const [logs, setLogs] = useState<Array<{ id: string; action: string; actorId: string | null; courseId: string | null; createdAt: string }>>([]);
  const [channels, setChannels] = useState<GuildChannelOption[]>([]);
  const [roles, setRoles] = useState<GuildRoleOption[]>([]);
  const [members, setMembers] = useState<GuildMemberOption[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [banner, setBanner] = useState<File | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    if (!botId) return;
    const [dashboard, options, memberOptions] = await Promise.all([
      getPoliceCoursesDashboard(guild.id, botId),
      getGuildLiveOptions(guild.id, botId),
      getGuildMemberOptions(guild.id, "", botId)
    ]);
    setConfig(dashboard.config);
    setCourses(dashboard.courses);
    setLogs(dashboard.logs);
    setChannels(options.channels.filter((channel) => channel.type === "text" || channel.type === "announcement"));
    setRoles(options.roles.filter((role) => !role.managed));
    setMembers(memberOptions.filter((member) => !member.bot));
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
      const payload = draft;
      let saved = draft.id ? await updatePoliceCourse(guild.id, botId, draft.id, payload) : await createPoliceCourse(guild.id, botId, payload);
      if (banner) saved = await uploadPoliceCourseBanner(guild.id, botId, saved.id, banner);
      setCourses((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setDraft(emptyDraft); setBanner(null); setEditing(false); setMessage("Curso salvo.");
    } catch (error: any) { setMessage(error?.response?.data?.message || "Nao foi possivel salvar o curso."); }
  }

  function patchConfig(patch: Partial<PoliceCourseConfig>) {
    if (!config || !canManage) return;
    setConfig({ ...config, ...patch });
  }

  async function saveConfig() {
    if (!botId || !config || !canManage) return;
    setSavingConfig(true);
    setMessage("");
    try {
      setConfig(await savePoliceCourseConfig(guild.id, botId, config));
      setMessage("Configuracao geral salva.");
    } catch (error: any) {
      setMessage(error?.response?.data?.message || "Nao foi possivel salvar a configuracao geral.");
    } finally {
      setSavingConfig(false);
    }
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
        <Field label="Identificador" value={draft.courseNumber} onChange={(courseNumber) => setDraft({ ...draft, courseNumber })} required />
        <Field label="Nome" value={draft.title} onChange={(title) => setDraft({ ...draft, title })} required />
        <Field label="Categoria" value={draft.category ?? ""} onChange={(category) => setDraft({ ...draft, category: category || null })} />
        <Field label="Ordem de exibição" type="number" value={String(draft.displayOrder)} onChange={(displayOrder) => setDraft({ ...draft, displayOrder: Math.max(0, Number(displayOrder) || 0) })} />
        <Field label="Emoji" value={draft.emoji ?? ""} onChange={(emoji) => setDraft({ ...draft, emoji: emoji || null })} />
        <Field label="Cor da Embed" type="color" value={draft.color ?? "#2563eb"} onChange={(color) => setDraft({ ...draft, color })} />
        <Channel label="Canal do painel" channels={channels} value={draft.panelChannelId || ""} change={(panelChannelId) => setDraft({ ...draft, panelChannelId: panelChannelId || null })} />
        <label className="space-y-2 text-sm"><span>Status</span><select className="h-10 w-full rounded-md border bg-background px-3" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as PoliceCourse["status"] })}><option value="draft">Rascunho</option><option value="open">Aberto</option><option value="in_progress">Em andamento</option><option value="finished">Finalizado</option><option value="canceled">Cancelado</option></select></label>
        <label className="space-y-2 text-sm"><span>Posição da imagem</span><select className="h-10 w-full rounded-md border bg-background px-3" value={draft.imagePosition} onChange={(event) => setDraft({ ...draft, imagePosition: event.target.value as Draft["imagePosition"] })}><option value="top">Banner superior</option><option value="thumbnail">Thumbnail lateral</option><option value="bottom">Rodapé</option><option value="none">Desativada</option></select></label>
        <MultiSelect label="Cargos de instrutor" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={draft.authorizedRoleIds} change={(authorizedRoleIds) => setDraft({ ...draft, authorizedRoleIds })} />
        <MultiSelect label="Instrutores específicos" options={members.map((member) => ({ id: member.id, name: member.displayName }))} values={draft.authorizedUserIds} change={(authorizedUserIds) => setDraft({ ...draft, authorizedUserIds })} />
        <MultiSelect label="Cargos que podem participar" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={draft.participantRoleIds} change={(participantRoleIds) => setDraft({ ...draft, participantRoleIds })} />
        <MultiSelect label="Cargos que podem visualizar" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={draft.viewerRoleIds} change={(viewerRoleIds) => setDraft({ ...draft, viewerRoleIds })} />
        <label className="space-y-2 text-sm"><span>Upload de banner</span><input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          if (file && file.size > 8 * 1024 * 1024) return setMessage("O banner deve ter no maximo 8 MB.");
          setBanner(file);
        }} /></label>
        <label className="space-y-2 text-sm md:col-span-2"><span>Descricao</span><textarea className="min-h-24 w-full rounded-md border bg-background p-3" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        {(banner || draft.bannerUrl) && draft.imagePosition !== "none" ? <div className={`border bg-[#313338] p-3 md:col-span-2 ${draft.imagePosition === "thumbnail" ? "grid grid-cols-[1fr_120px] gap-3" : ""}`}><div><strong>Prévia do painel</strong><p className="mt-2 text-sm">{draft.title || "Nome do curso"}</p><p className="text-xs text-zinc-400">Instrutor, horário, vagas, local e alunos serão preenchidos na abertura.</p></div><img className={draft.imagePosition === "thumbnail" ? "h-24 w-24 object-cover" : "max-h-64 w-full object-cover"} src={banner ? URL.createObjectURL(banner) : draft.bannerUrl || ""} alt="Prévia do banner" /></div> : null}
        <div className="flex gap-2 md:col-span-2">
          <Button type="submit"><Save className="mr-2 h-4 w-4" />Salvar</Button>
          <Button type="button" variant="outline" onClick={() => { setDraft(emptyDraft); setBanner(null); setEditing(false); }}>
            <ArrowLeft className="mr-2 h-4 w-4" />Voltar
          </Button>
        </div>
      </form>
    </CardContent></Card> : null}
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Configuracao geral</CardTitle>
            <CardDescription>Altere os campos e clique em salvar para persistir no bot.</CardDescription>
          </div>
          <Button disabled={!canManage || savingConfig} onClick={() => void saveConfig()}>
            <Save className="mr-2 h-4 w-4" />{savingConfig ? "Salvando..." : "Salvar configuracao"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <Toggle label="Sistema ativo" value={config.enabled} change={(enabled) => patchConfig({ enabled })} />
        <Toggle label="DM ao finalizar" value={config.dmOnFinish} change={(dmOnFinish) => patchConfig({ dmOnFinish })} />
        <Toggle label="DM ao cancelar" value={config.dmOnCancel} change={(dmOnCancel) => patchConfig({ dmOnCancel })} />
        <Toggle label="Permitir entrar depois de iniciado" value={config.allowJoinAfterStart} change={(allowJoinAfterStart) => patchConfig({ allowJoinAfterStart })} />
        <Toggle label="Permitir sair depois de iniciado" value={config.allowLeaveAfterStart} change={(allowLeaveAfterStart) => patchConfig({ allowLeaveAfterStart })} />
        <Toggle label="Bloquear canal ao finalizar" value={config.lockChannelOnFinish} change={(lockChannelOnFinish) => patchConfig({ lockChannelOnFinish })} />
        <Toggle label="Bloquear canal ao cancelar" value={config.lockChannelOnCancel} change={(lockChannelOnCancel) => patchConfig({ lockChannelOnCancel })} />
        <Toggle label="Apagar painel ao cancelar" value={config.deletePanelOnCancel} change={(deletePanelOnCancel) => patchConfig({ deletePanelOnCancel })} />
        <Channel label="Canal de logs" channels={channels} value={config.logChannelId || ""} change={(logChannelId) => patchConfig({ logChannelId: logChannelId || null })} />
        <Channel label="Canal de aprovações" channels={channels} value={config.approvalChannelId || ""} change={(approvalChannelId) => patchConfig({ approvalChannelId: approvalChannelId || null })} />
        <Channel label="Canal de certificados" channels={channels} value={config.certificateChannelId || ""} change={(certificateChannelId) => patchConfig({ certificateChannelId: certificateChannelId || null })} />
        <Channel label="Canal de notificações" channels={channels} value={config.notificationChannelId || ""} change={(notificationChannelId) => patchConfig({ notificationChannelId: notificationChannelId || null })} />
        <Channel label="Canal padrao" channels={channels} value={config.defaultPanelChannelId || ""} change={(defaultPanelChannelId) => patchConfig({ defaultPanelChannelId: defaultPanelChannelId || null })} />
        <MultiSelect label="Administrador Geral da Unidade" options={members.map((member) => ({ id: member.id, name: member.displayName }))} values={config.generalManagerUserIds} change={(generalManagerUserIds) => patchConfig({ generalManagerUserIds })} />
        <MultiSelect label="Cargos que criam cursos" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={config.createRoleIds} change={(createRoleIds) => patchConfig({ createRoleIds })} />
        <MultiSelect label="Cargos que editam cursos" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={config.editRoleIds} change={(editRoleIds) => patchConfig({ editRoleIds })} />
        <MultiSelect label="Cargos que excluem cursos" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={config.deleteRoleIds} change={(deleteRoleIds) => patchConfig({ deleteRoleIds })} />
        <MultiSelect label="Cargos que aprovam" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={config.approveRoleIds} change={(approveRoleIds) => patchConfig({ approveRoleIds })} />
        <MultiSelect label="Cargos que cancelam" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={config.cancelRoleIds} change={(cancelRoleIds) => patchConfig({ cancelRoleIds })} />
        <MultiSelect label="Cargos que concluem" options={roles.map((role) => ({ id: role.id, name: role.name }))} values={config.concludeRoleIds} change={(concludeRoleIds) => patchConfig({ concludeRoleIds })} />
      </CardContent>
    </Card>
    <div className="grid gap-4 xl:grid-cols-2">{courses.map((course) => <Card key={course.id}>
      {course.bannerUrl ? <img className="h-44 w-full object-cover" src={course.bannerUrl} alt="" /> : null}
      <CardHeader><CardTitle>{course.courseNumber} - {course.title}</CardTitle><CardDescription>{course.status} • {course.participants.length}{course.maxSlots ? `/${course.maxSlots}` : ""} inscritos</CardDescription></CardHeader>
      <CardContent className="space-y-4"><p className="text-sm">{course.authorizedRoleIds.length} cargo(s) e {course.authorizedUserIds.length} usuário(s) instrutores • {course.panelChannelId ? `#${channels.find((item) => item.id === course.panelChannelId)?.name ?? course.panelChannelId}` : "canal não configurado"}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => { setDraft({ id: course.id, courseNumber: course.courseNumber, title: course.title, category: course.category, displayOrder: course.displayOrder, status: course.status, emoji: course.emoji, color: course.color, description: course.description, bannerUrl: course.bannerUrl, imagePosition: course.imagePosition, panelChannelId: course.panelChannelId, authorizedRoleIds: course.authorizedRoleIds, authorizedUserIds: course.authorizedUserIds, participantRoleIds: course.participantRoleIds, viewerRoleIds: course.viewerRoleIds }); setEditing(true); }}><Pencil className="mr-2 h-4 w-4" />Editar</Button>
          <Button size="sm" variant="outline" onClick={async () => { await publishPoliceCourse(guild.id, botId, course.id, course.panelChannelId || config.defaultPanelChannelId); setMessage("Publicacao do painel solicitada."); }}>Publicar painel</Button>
          <Button size="sm" variant="destructive" onClick={async () => { if (window.confirm("Excluir este curso?")) { await deletePoliceCourse(guild.id, botId, course.id); setCourses((items) => items.filter((item) => item.id !== course.id)); } }}><Trash2 className="mr-2 h-4 w-4" />Excluir</Button>
        </div>
      </CardContent>
    </Card>)}</div>
    <Card><CardHeader><CardTitle>Logs recentes</CardTitle><CardDescription>Ações registradas pelo bot e pela dashboard.</CardDescription></CardHeader><CardContent className="space-y-2">
      {logs.length ? logs.slice(0, 30).map((log) => {
        const course = courses.find((item) => item.id === log.courseId);
        return <div className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm" key={log.id}><span>{log.action.replaceAll("_", " ")} • {course?.title ?? "Configuração geral"} • {log.actorId ? `@${members.find((item) => item.id === log.actorId)?.displayName ?? log.actorId}` : "Sistema"}</span><time className="text-muted-foreground">{new Date(log.createdAt).toLocaleString("pt-BR")}</time></div>;
      }) : <p className="text-sm text-muted-foreground">Nenhuma ação registrada.</p>}
    </CardContent></Card>
  </div>;
}

function Field({ label, value, onChange, required, type = "text" }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string }) { return <label className="space-y-2 text-sm"><span>{label}</span><input className="h-10 w-full rounded-md border bg-background px-3" type={type} value={value} required={required} onChange={(event) => onChange(event.target.value)} /></label>; }
function Toggle({ label, value, change }: { label: string; value: boolean; change: (value: boolean) => void }) { return <label className="flex items-center justify-between border p-3 text-sm"><span>{label}</span><Switch checked={value} onCheckedChange={change} /></label>; }
function Channel({ label, channels, value, change }: { label: string; channels: GuildChannelOption[]; value: string; change: (value: string) => void }) { return <label className="space-y-2 text-sm"><span>{label}</span><select className="h-10 w-full rounded-md border bg-background px-3" value={value} onChange={(event) => change(event.target.value)}><option value="">Nao configurado</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>; }
function MultiSelect({ label, options, values, change }: { label: string; options: Array<{ id: string; name: string }>; values: string[]; change: (value: string[]) => void }) { return <label className="space-y-2 text-sm"><span>{label}</span><select multiple className="min-h-32 w-full rounded-md border bg-background p-2" value={values} onChange={(event) => change(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>; }
