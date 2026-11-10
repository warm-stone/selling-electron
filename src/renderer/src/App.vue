<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  DataAnalysis,
  Goods,
  Printer,
  Setting,
  ShoppingCart,
  Tickets,
  User,
  Van
} from '@element-plus/icons-vue'
import { useAppStore } from '@renderer/stores/app'

const route = useRoute()
const appStore = useAppStore()

/** 侧边导航：与 router/index.ts 的 8 条业务路由一一对应 */
const menus = [
  { path: '/pos', label: '收银台', icon: ShoppingCart },
  { path: '/products', label: '商品管理', icon: Goods },
  { path: '/purchases', label: '进货管理', icon: Van },
  { path: '/sales-history', label: '销售记录', icon: Tickets },
  { path: '/customers', label: '客户管理', icon: User },
  { path: '/reports', label: '报表统计', icon: DataAnalysis },
  { path: '/template-editor', label: '小票模板', icon: Printer },
  { path: '/settings', label: '系统设置', icon: Setting }
]

// 菜单高亮随路由同步（router.push 后 default-active 响应式更新）
const activeMenu = computed(() => route.path)
</script>

<template>
  <el-container class="app-shell">
    <el-aside class="app-aside" width="200px">
      <div class="app-brand">
        <span class="app-brand__logo">销</span>
        <div class="app-brand__text">
          <span class="app-brand__name">{{ appStore.appName }}</span>
          <span class="app-brand__version">v{{ appStore.appVersion }}</span>
        </div>
      </div>
      <el-menu class="app-menu" router :default-active="activeMenu">
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.app-shell {
  height: 100vh;
}

/* ── 侧边栏：深墨底 + Element Plus 琥珀点缀（零售收银气质）── */
.app-aside {
  display: flex;
  flex-direction: column;
  background: #16181d;
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 64px;
  padding: 0 16px;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.app-brand__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-warning);
  color: #16181d;
  font-size: 15px;
  font-weight: 700;
}

.app-brand__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.app-brand__name {
  color: #ffffff;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.app-brand__version {
  color: rgba(255, 255, 255, 0.42);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  user-select: text;
}

/* 沿用 Element Plus menu 令牌体系做深色定制 */
.app-menu {
  flex: 1;
  padding-top: 8px;
  border-right: none;

  --el-menu-bg-color: transparent;
  --el-menu-text-color: rgba(255, 255, 255, 0.62);
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.06);
  --el-menu-active-color: var(--el-color-warning);
  --el-menu-item-height: 48px;
}

.app-menu :deep(.el-menu-item.is-active) {
  background: rgba(230, 162, 60, 0.12);
  box-shadow: inset 3px 0 0 var(--el-color-warning);
}

/* ── 主区域：交由各业务页自管留白 ── */
.app-main {
  padding: 0;
  overflow: auto;
  background: var(--el-bg-color-page);
}
</style>
