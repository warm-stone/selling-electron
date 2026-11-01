import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

// Electron file:// 环境硬约束：必须使用 hash 模式
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/pos' },
  {
    path: '/pos',
    name: 'pos',
    component: () => import('@renderer/views/PosView.vue')
  },
  {
    path: '/products',
    name: 'products',
    component: () => import('@renderer/views/ProductsView.vue')
  },
  {
    path: '/purchases',
    name: 'purchases',
    component: () => import('@renderer/views/PurchasesView.vue')
  },
  {
    path: '/sales-history',
    name: 'sales-history',
    component: () => import('@renderer/views/SalesHistoryView.vue')
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('@renderer/views/ReportsView.vue')
  },
  {
    path: '/template-editor',
    name: 'template-editor',
    component: () => import('@renderer/views/TemplateEditorView.vue')
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@renderer/views/SettingsView.vue')
  },
  // 兜底：未知路径回收银台
  { path: '/:pathMatch(.*)*', redirect: '/pos' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
