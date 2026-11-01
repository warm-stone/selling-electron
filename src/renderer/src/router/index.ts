import { createRouter, createWebHashHistory } from 'vue-router'

// Electron file:// 环境硬约束：必须使用 hash 模式
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@renderer/views/HomeView.vue')
    }
  ]
})

export default router
