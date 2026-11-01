import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'
import './assets/base.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
// 中文 locale（Task 13：分页「共 N 条」等内置文案中文化——全应用统一）
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')
