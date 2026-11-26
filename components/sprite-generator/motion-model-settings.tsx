'use client';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useState } from 'react';
import { motionRequest } from './open-motion-model';

export type ModelProfile = {
  provider: 'tokenhub' | 'openai';
  model: string;
  max_output_tokens: number;
  timeout_seconds: number;
  token_parameter: 'auto' | 'max_tokens' | 'max_completion_tokens';
  reasoning_effort: 'auto' | 'low' | 'medium' | 'high' | 'max';
  supports_images: boolean;
};
type ModelConfiguration = {
  version: 1;
  default: ModelProfile;
  roles: Record<string, ModelProfile>;
  saved_models: ModelProfile[];
};
export type MotionConfiguration = {
  provider: string;
  model: string;
  planning_configured: boolean;
  pixellab_configured: boolean;
  configuration?: ModelConfiguration;
  services?: {
    id: string;
    label: string;
    endpoint: string;
    configured: boolean;
    credential_source?: 'environment' | 'protected_local' | 'missing';
  }[];
  effective_roles?: Record<string, ModelProfile & { configured: boolean }>;
};
const base: ModelProfile = {
  provider: 'tokenhub',
  model: 'glm-5.3-flash',
  max_output_tokens: 16384,
  timeout_seconds: 300,
  token_parameter: 'auto',
  reasoning_effort: 'low',
  supports_images: true,
};
const suggested: ModelProfile[] = [
  base,
  {
    ...base,
    model: 'kimi-k3.1-pro',
    max_output_tokens: 32768,
    reasoning_effort: 'low',
    timeout_seconds: 420,
  },
  {
    ...base,
    provider: 'openai',
    model: 'gpt-5.4-2026-03-05',
    max_output_tokens: 8000,
    timeout_seconds: 180,
    reasoning_effort: 'auto',
  },
];
const roles = {
  appearance: '外观专家',
  motion: '动作理解专家',
  strategy: '生成策略专家',
  coordinator: '协调专家',
  reviewer: '视觉复核',
  structure: '角色结构解析',
};
const identity = (p: ModelProfile) => `${p.provider}|${p.model}`;

export function MotionModelSettings({
  configuration,
  onSaved,
}: {
  configuration: MotionConfiguration | null;
  onSaved: (value: MotionConfiguration) => void;
}) {
  const [draft, setDraft] = useState<ModelConfiguration | null>(null);
  const [editing, setEditing] = useState<ModelProfile>({ ...base, model: '' });
  const [keys, setKeys] = useState({
    tokenhub_key: '',
    openai_key: '',
    pixellab_key: '',
  });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  if (!configuration)
    return (
      <div className="motion-popover-body motion-settings">
        正在读取已保存的模型与服务状态…
      </div>
    );
  const current = draft ||
    configuration?.configuration || {
      version: 1 as const,
      default: base,
      roles: {},
      saved_models: [],
    };
  const models = [
    ...new Map(
      [
        ...suggested,
        ...current.saved_models,
        current.default,
        ...Object.values(current.roles),
      ].map((p) => [identity(p), p]),
    ).values(),
  ];
  const choose = (value: string) => models.find((p) => identity(p) === value)!;
  return (
    <div className="motion-popover-body motion-settings">
      <h3>专家模型与生成服务</h3>
      <p>
        规划负责理解、约束和分段；视觉复核检查实际帧；PixelLab
        负责绘制。保存配置不会调用模型，只影响新规划的任务。
        增强复核的外观、运动与争议角色共用下方的视觉复核模型，分别保存意见与调用记录。
      </p>
      <label>
        默认规划模型
        <NativeSelect
          aria-label="默认规划模型"
          value={identity(current.default)}
          onChange={(e) =>
            setDraft({ ...current, default: choose(e.target.value) })
          }
        >
          {models.map((p) => (
            <NativeSelectOption key={identity(p)} value={identity(p)}>
              {p.provider} · {p.model}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label>
        视觉复核模型
        <NativeSelect
          aria-label="视觉复核模型"
          value={current.roles.reviewer ? identity(current.roles.reviewer) : ''}
          onChange={(e) => {
            const next = { ...current.roles };
            if (e.target.value) next.reviewer = choose(e.target.value);
            else delete next.reviewer;
            setDraft({ ...current, roles: next });
          }}
        >
          <NativeSelectOption value="">与默认规划模型相同</NativeSelectOption>
          {models.map((p) => (
            <NativeSelectOption key={identity(p)} value={identity(p)}>
              {p.provider} · {p.model}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <details open>
        <summary>API Key 与服务状态</summary>
        {(configuration?.services || []).map((s) => (
          <p key={s.id}>
            {s.label}：{s.configured ? 'Key 已配置' : '尚未配置 Key'}
            <br />
            <small>{s.endpoint}</small>
            {s.credential_source && (
              <small>
                {' '}
                ·{' '}
                {s.credential_source === 'environment'
                  ? '来自启动环境'
                  : s.credential_source === 'protected_local'
                    ? '已在本机加密保存'
                    : '尚无凭据'}
              </small>
            )}
          </p>
        ))}
        <p>
          PixelLab：
          {configuration?.pixellab_configured ? 'Key 已配置' : '尚未配置 Key'}
        </p>
        {(
          [
            ['tokenhub_key', 'TokenHub API Key'],
            ['openai_key', 'OpenAI API Key'],
            ['pixellab_key', 'PixelLab API Key'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="password"
              autoComplete="off"
              value={keys[key]}
              onChange={(e) => setKeys({ ...keys, [key]: e.target.value })}
              placeholder="留空保留已有 Key"
            />
          </label>
        ))}
      </details>
      <details>
        <summary>各专家单独指定模型</summary>
        {Object.entries(roles)
          .filter(([role]) => role !== 'reviewer')
          .map(([role, label]) => (
            <label key={role}>
              {label}
              <NativeSelect
                aria-label={`${label}模型`}
                value={current.roles[role] ? identity(current.roles[role]) : ''}
                onChange={(e) => {
                  const next = { ...current.roles };
                  if (e.target.value) next[role] = choose(e.target.value);
                  else delete next[role];
                  setDraft({ ...current, roles: next });
                }}
              >
                <NativeSelectOption value="">使用默认规划模型</NativeSelectOption>
                {models.map((p) => (
                  <NativeSelectOption key={identity(p)} value={identity(p)}>
                    {p.provider} · {p.model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ))}
      </details>
      <details>
        <summary>新增或编辑可选模型</summary>
        <label>
          编辑已有型号
          <NativeSelect
            aria-label="编辑已有型号"
            value=""
            onChange={(e) => setEditing({ ...choose(e.target.value) })}
          >
            <NativeSelectOption value="">选择后修改参数，或直接新增</NativeSelectOption>
            {models.map((p) => (
              <NativeSelectOption key={identity(p)} value={identity(p)}>
                {p.provider} · {p.model}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label>
          API 服务
          <NativeSelect
            aria-label="新增模型 API 服务"
            value={editing.provider}
            onChange={(e) =>
              setEditing({
                ...editing,
                provider: e.target.value as ModelProfile['provider'],
              })
            }
          >
            <NativeSelectOption value="tokenhub">腾讯云 TokenHub</NativeSelectOption>
            <NativeSelectOption value="openai">OpenAI Responses</NativeSelectOption>
          </NativeSelect>
        </label>
        <label>
          模型 ID
          <input
            aria-label="新增模型 ID"
            value={editing.model}
            onChange={(e) =>
              setEditing({ ...editing, model: e.target.value.trim() })
            }
            placeholder="填写服务商提供的准确模型 ID"
          />
        </label>
        <p>
          新增型号共用该服务的 Key；需要支持图片输入和结构化 JSON。填写 ID
          不代表账号已经开通该模型。
        </p>
        <label>
          单次输出 Token 上限
          <input
            aria-label="模型输出 Token 上限"
            type="number"
            min={1024}
            max={32768}
            value={editing.max_output_tokens}
            onChange={(e) =>
              setEditing({
                ...editing,
                max_output_tokens: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          推理强度
          <NativeSelect
            aria-label="模型推理强度"
            value={editing.reasoning_effort}
            onChange={(e) =>
              setEditing({
                ...editing,
                reasoning_effort: e.target
                  .value as ModelProfile['reasoning_effort'],
              })
            }
          >
            {['auto', 'low', 'medium', 'high', 'max'].map((v) => (
              <NativeSelectOption key={v} value={v}>
                {v === 'auto' ? '服务商默认' : v}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label>
          单次请求等待上限（秒）
          <input
            aria-label="模型请求超时"
            type="number"
            min={30}
            max={600}
            value={editing.timeout_seconds}
            onChange={(e) =>
              setEditing({
                ...editing,
                timeout_seconds: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Token 参数
          <NativeSelect
            aria-label="模型 Token 参数"
            value={editing.token_parameter}
            onChange={(e) =>
              setEditing({
                ...editing,
                token_parameter: e.target
                  .value as ModelProfile['token_parameter'],
              })
            }
          >
            {['auto', 'max_tokens', 'max_completion_tokens'].map((v) => (
              <NativeSelectOption key={v} value={v}>
                {v === 'auto'
                  ? '自动适配（Kimi K3 使用 max_completion_tokens）'
                  : v}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <button
          disabled={!editing.model || current.saved_models.length >= 24}
          onClick={() => {
            setDraft({
              ...current,
              saved_models: [
                ...current.saved_models.filter(
                  (p) => identity(p) !== identity(editing),
                ),
                { ...editing },
              ],
              default:
                identity(current.default) === identity(editing)
                  ? { ...editing }
                  : current.default,
              roles: Object.fromEntries(
                Object.entries(current.roles).map(([r, p]) => [
                  r,
                  identity(p) === identity(editing) ? { ...editing } : p,
                ]),
              ),
            });
            setMessage(
              '已加入可选列表。分配给专家后，点击底部“保存配置”生效。',
            );
          }}
        >
          加入可选模型
        </button>
        {current.saved_models.map((p) => (
          <div key={identity(p)}>
            {p.provider} · {p.model}{' '}
            <button
              onClick={() =>
                setDraft({
                  ...current,
                  saved_models: current.saved_models.filter(
                    (m) => identity(m) !== identity(p),
                  ),
                })
              }
            >
              移出可选列表
            </button>
          </div>
        ))}
      </details>

      {message && <p role="alert">{message}</p>}
      <button
        className="motion-settings-save"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage('');
          try {
            const value = await motionRequest<MotionConfiguration>(
              'open-motion/settings',
              {
                configuration: current,
                ...Object.fromEntries(
                  Object.entries(keys).filter(([, v]) => v.trim()),
                ),
              },
            );
            setDraft(null);
            setKeys({ tokenhub_key: '', openai_key: '', pixellab_key: '' });
            onSaved(value);
            setMessage('已保存。已有任务继续使用它创建时的模型配置。');
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '正在保存…' : '保存配置'}
      </button>
    </div>
  );
}
