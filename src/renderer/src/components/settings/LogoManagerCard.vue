<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Picture } from '@element-plus/icons-vue'
import type { LogoInfo } from '../../../../shared/types'

/**
 * 设置页·卡片三：小票 Logo 管理（多 Logo 架构——此处上传，
 * 小票模板的图片段落选用）。
 *
 * 卡片自治（SettingsView 拆分）：自持列表态，挂载时 settings:listLogos；
 * 上传（原生对话框在主进程，取消 → 列表不变不 toast）与删除（确认弹窗）
 * 的 IPC 与 toast 本组件闭环。
 */

const loading = ref(true)
const logos = ref<LogoInfo[]>([])
const uploadingLogo = ref(false)

async function loadLogos(): Promise<void> {
  logos.value = await window.api.settings.listLogos()
}

onMounted(async () => {
  try {
    await loadLogos()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`设置加载失败：${detail}`)
  } finally {
    loading.value = false
  }
})

async function onUploadLogo(): Promise<void> {
  uploadingLogo.value = true
  try {
    const next = await window.api.settings.uploadLogo()
    // 原生对话框用户取消 → 返回原列表（长度不变不 toast，避免误导）
    const added = next.length > logos.value.length
    logos.value = next
    if (added) ElMessage.success('Logo 已上传')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`Logo 上传失败：${detail}`)
  } finally {
    uploadingLogo.value = false
  }
}

async function onDeleteLogo(logo: LogoInfo): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除 Logo「${logo.display_name}」？引用它的小票模板将不再打印该图。`,
      '删除 Logo',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    logos.value = await window.api.settings.deleteLogo(logo.id)
    ElMessage.success('Logo 已删除')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`Logo 删除失败：${detail}`)
  }
}
</script>

<template>
  <!-- ═══ 卡片三：小票 Logo（多 Logo 管理：此处上传，小票模板的图片段落选用）═══ -->
  <el-card
    v-loading="loading"
    class="settings-card"
    shadow="never"
  >
    <template #header>
      <div class="card-head">
        <span
          class="card-head__marker"
          aria-hidden="true"
        />
        <span class="card-head__title">小票 Logo</span>
        <span class="card-head__desc">可上传多张，在小票模板的图片段落中选择使用</span>
      </div>
    </template>

    <div
      v-if="logos.length > 0"
      class="logo-grid"
      data-testid="logo-grid"
    >
      <div
        v-for="logo in logos"
        :key="logo.id"
        class="logo-cell"
        data-testid="logo-item"
      >
        <div class="logo-cell__thumb">
          <img
            :src="logo.data_url"
            :alt="logo.display_name"
            class="logo-cell__img"
            data-testid="logo-preview"
          >
        </div>
        <span
          class="logo-cell__name"
          :title="logo.display_name"
        >{{ logo.display_name }}</span>
        <el-button
          text
          type="danger"
          size="small"
          :icon="Delete"
          data-testid="logo-delete-btn"
          @click="onDeleteLogo(logo)"
        >
          删除
        </el-button>
      </div>
    </div>
    <div
      v-else
      class="logo-empty"
    >
      <el-icon
        :size="26"
        class="logo-empty__icon"
      >
        <Picture />
      </el-icon>
      <p class="logo-empty__text">
        暂未上传 Logo，上传后可在小票模板中选择使用
      </p>
    </div>

    <footer class="card-foot">
      <span class="card-foot__hint">仅支持 PNG，建议黑白图、宽不超过 300 像素。</span>
      <el-button
        type="primary"
        plain
        data-testid="upload-logo-btn"
        :loading="uploadingLogo"
        @click="onUploadLogo"
      >
        上传 Logo
      </el-button>
    </footer>
  </el-card>
</template>

<style scoped>
/* ── 多 Logo 响应式网格（缩略图限高保持比例 + 名称 + 删除）── */
.logo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.logo-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 10px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: #fff;
}

.logo-cell__thumb {
  display: flex;
  width: 100%;
  height: 64px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.logo-cell__img {
  max-width: 100%;
  max-height: 64px;
  object-fit: contain;
}

.logo-cell__name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

/* ── Logo 空态 ── */
.logo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 0 20px;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.logo-empty__icon {
  color: var(--el-text-color-placeholder);
}

.logo-empty__text {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
