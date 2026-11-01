<script setup lang="ts">
/**
 * 通用空态占位页（Task 6）
 * 7 条业务路由的临时内容；各业务任务落地时由真实页面整体替换。
 */
defineProps<{
  /** 页面标题（中文） */
  title: string
  /** 空态描述，默认"建设中" */
  description?: string
}>()
</script>

<template>
  <section class="placeholder-page">
    <h2 class="placeholder-page__title">{{ title }}</h2>
    <el-empty
      class="placeholder-page__empty"
      :description="description ?? '功能建设中，敬请期待'"
      :image-size="140"
    />
  </section>
</template>

<style scoped>
.placeholder-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.placeholder-page__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}
</style>
