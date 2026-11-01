<script setup lang="ts">
import { ref } from 'vue'

// Task 1 占位页：验证 Vue3 + Element Plus + preload contextBridge 接线
// （业务页面由 Task 6+ 逐步替换本文件所在 views/ 目录）
const pingResult = ref('')

function onPing(): void {
  pingResult.value = window.api ? window.api.ping() : 'api 未暴露'
}
</script>

<template>
  <main class="home">
    <h1>桌面销存系统</h1>
    <p>脚手架就绪：electron-vite 6 + Vue 3 + TypeScript + Element Plus</p>
    <el-button type="primary" @click="onPing">Element Plus 按钮</el-button>
    <p v-if="pingResult">preload api.ping() → {{ pingResult }}</p>
    <p class="mono-cjk">等宽 CJK 0123456789 中文对齐</p>
  </main>
</template>

<style scoped>
.home {
  padding: 24px;
}
</style>
