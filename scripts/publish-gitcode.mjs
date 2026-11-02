#!/usr/bin/env node
/**
 * 将 NSIS 安装包上传到 GitCode Releases（双发：GitHub 构建产物同步 GitCode）。
 *
 * 用法（在 release workflow 内，构建产物已就位于 release/ 目录）：
 *   node scripts/publish-gitcode.mjs
 *
 * 环境变量：
 *   GITCODE_TOKEN  GitCode access token（GitHub secrets 注入）
 *   GITCODE_REPO   仓库坐标 owner/repo（如 warm-stone/selling-electron）
 *   GITCODE_TAG    Release 标签（与 GitHub Release 同名，如 v0.1.0）
 *
 * API（gitcode.com/api/v5，预签名 OBS 直传）：
 *   1. GET  /repos/{repo}/releases/tags/{tag}          → 已存在则复用
 *      否则 POST /repos/{repo}/releases                  → 创建（tag_name/name/body）
 *   2. GET  /repos/{repo}/releases/{tag}/upload_url?file_name=xx.exe
 *      → { url, headers }（预签名） → PUT 文件字节
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
// undici（node fetch 底层）默认 headersTimeout=300s：跨境上传 ~100MB 安装包
// 到 GitCode 国内 OBS 的耗时远超此限（实测 HeadersTimeoutError）——解除该限制
import { Agent, setGlobalDispatcher } from 'undici'

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

const TOKEN = process.env.GITCODE_TOKEN
const REPO = process.env.GITCODE_REPO
const TAG = process.env.GITCODE_TAG
const RELEASE_DIR = 'release'

if (!TOKEN || !REPO || !TAG) {
  console.error('缺少环境变量：GITCODE_TOKEN / GITCODE_REPO / GITCODE_TAG')
  process.exit(1)
}

const BASE = `https://gitcode.com/api/v5/repos/${REPO}`

async function apiText(path, init) {
  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`)
  }
  return text
}

/** GET 谓词带 token（query 传参，勿打印完整 URL） */
function authedPath(path) {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}access_token=${encodeURIComponent(TOKEN)}`
}

async function ensureRelease() {
  const existing = await fetch(`${BASE}/releases/tags/${encodeURIComponent(TAG)}?access_token=${encodeURIComponent(TOKEN)}`)
  if (existing.ok) {
    console.log(`GitCode Release ${TAG} 已存在，复用`)
    return
  }
  if (existing.status !== 404) {
    throw new Error(`查询 Release 失败：HTTP ${existing.status} ${await existing.text()}`)
  }
  const form = new FormData()
  form.set('tag_name', TAG)
  form.set('name', TAG)
  form.set('body', `销存系统 ${TAG}（Windows NSIS 安装包，与 GitHub Releases 同源）`)
  // GitCode API v5 认 query 的 access_token（Authorization: token 头实测 401 "token not found"）
  await apiText(authedPath('/releases'), {
    method: 'POST',
    body: form
  })
  console.log(`GitCode Release ${TAG} 创建完成`)
}

async function uploadAsset(filePath) {
  const fileName = basename(filePath)
  const presignText = await apiText(
    authedPath(`/releases/${encodeURIComponent(TAG)}/upload_url?file_name=${encodeURIComponent(fileName)}`)
  )
  const { url, headers } = JSON.parse(presignText)
  if (!url || !headers) {
    throw new Error(`upload_url 响应缺少预签名字段：${presignText.slice(0, 300)}`)
  }
  const body = readFileSync(filePath)

  // 跨境上传（GitHub 美国机房 → GitCode 国内 OBS）：整体 30 分钟硬上限，
  // 网络抖动重试 2 次（预签名 PUT 幂等，断点重传安全）
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers,
        body,
        signal: AbortSignal.timeout(30 * 60 * 1000)
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
      }
      console.log(`GitCode 上传 ${fileName} 完成（HTTP ${res.status}，第 ${attempt} 次尝试）`)
      return
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`上传 ${fileName} 失败（已重试 ${MAX_ATTEMPTS - 1} 次）：${err.message}`)
      }
      console.log(`GitCode 上传 ${fileName} 第 ${attempt} 次尝试失败（${err.message}），重试…`)
      await new Promise((r) => setTimeout(r, 5000 * attempt))
    }
  }
}

const installers = readdirSync(RELEASE_DIR)
  .filter((f) => f.endsWith('-setup.exe'))
  .map((f) => join(RELEASE_DIR, f))

if (installers.length === 0) {
  console.error(`release/ 下未找到 *-setup.exe 安装包`)
  process.exit(1)
}

await ensureRelease()
for (const installer of installers) {
  await uploadAsset(installer)
}
console.log(`双发完成：${installers.length} 个安装包已上传 GitCode Releases`)
