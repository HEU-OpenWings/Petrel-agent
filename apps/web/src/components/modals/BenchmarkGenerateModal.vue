<template>
<a-modal
  v-model:open="visible"
  title="自动生成评估基准"
  width="600px"
  :confirm-loading="generating"
  @ok="handleGenerate"
  @cancel="handleCancel"
>
  <a-form
    ref="formRef"
    :model="formState"
    :rules="rules"
    layout="vertical"
  >
    <a-form-item label="基准名称" name="name">
      <a-input
        v-model:value="formState.name"
        placeholder="请输入评估基准名称"
      />
    </a-form-item>

    <a-form-item label="描述" name="description">
      <a-textarea
        v-model:value="formState.description"
        placeholder="请输入评估基准描述（可选）"
        :rows="3"
      </a-textarea>
    </a-form-item>

    <a-form-item label="生成参数" name="params" :extra="extraText">
      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="问题数量" name="count" :label-col="{ span: 24 }" :wrapper-col="{ span: 24 }">
            <a-input-number
              v-model:value="formState.count"
              :min="1"
              :max="100"
              style="width: 100%"
              placeholder="生成问题数量"
            />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="相似chunks数量" name="neighbors_count" :label-col="{ span: 24 }" :wrapper-col="{ span: 24 }">
            <a-input-number
              v-model:value="formState.neighbors_count"
              :min="0"
              :max="10"
              style="width: 100%"
              placeholder="每次选取的相似chunks数量"
            />
          </a-form-item>
        </a-col>
      </a-row>




    </a-form-item>

    <a-form-item label="LLM配置" name="llm_config">
      <a-card size="small" title="配置参数">
        <a-form-item label="LLM模型配置" name="llm_model_spec" :rules="[{ required: true, message: '请选择LLM模型' }]">
          <ModelSelectorComponent
            :model-spec="formState.llm_model_spec"
            placeholder="选择用于生成问题的LLM模型"
            size="small"
            @select-model="handleSelectLLMModel"
          />
        </a-form-item>

        <a-form-item label="Embedding模型" name="embedding_model_id" :rules="[{ required: true, message: '请选择Embedding模型' }]">
          <EmbeddingModelSelector
            v-model:value="formState.embedding_model_id"
            placeholder="请选择用于相似度计算的Embedding模型"
            size="default"
          />
        </a-form-item>

        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="Temperature" name="temperature" :label-col="{ span: 24 }" :wrapper-col="{ span: 24 }">
              <a-input-number
                v-model:value="formState.llm_config.temperature"
                :min="0"
                :max="2"
                :step="0.1"
                style="width: 100%"
                placeholder="控制生成内容的随机性"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Max Tokens" name="max_tokens" :label-col="{ span: 24 }" :wrapper-col="{ span: 24 }">
              <a-input-number
                v-model:value="formState.llm_config.max_tokens"
                :min="100"
                :max="4000"
                :step="100"
                style="width: 100%"
                placeholder="生成内容的最大长度"
              />
            </a-form-item>
          </a-col>
        </a-row>
      </a-card>
    </a-form-item>

    </a-form>
</a-modal>
</template>

<script setup>
import { message } from "ant-design-vue";
import { computed, h, reactive, ref, watch } from "vue";
import { evaluationApi } from "@/apis/knowledge_api";
import EmbeddingModelSelector from "@/components/EmbeddingModelSelector.vue";
import ModelSelectorComponent from "@/components/ModelSelectorComponent.vue";

const props = defineProps({
  visible: {
    type: Boolean,
    default: false,
  },
  databaseId: {
    type: String,
    required: true,
  },
});

const emit = defineEmits(["update:visible", "success"]);

// 响应式数据
const formRef = ref();
const generating = ref(false);

const formState = reactive({
  name: "",
  description: "",
  count: 10,
  neighbors_count: 2,
  embedding_model_id: "",
  llm_model_spec: "",
  llm_config: {
    model: "",
    temperature: 0.7,
    max_tokens: 1000,
  },
});

// 表单验证规则
const rules = {
  name: [
    { required: true, message: "请输入基准名称", trigger: "blur" },
    { min: 2, max: 100, message: "基准名称长度应在2-100个字符之间", trigger: "blur" },
  ],
  count: [{ required: true, message: "请输入生成问题数量", trigger: "blur" }],
};

// 双向绑定visible
const visible = computed({
  get: () => props.visible,
  set: (val) => emit("update:visible", val),
});

// 说明文本。原本尾部挂着一个指向上游 Yuxi-Know 文档的「使用说明」外链，
// Petrel 还没有对应文档，先只留文案
const extraText = computed(() => h("span", {}, "评估基准由模型依据知识库内容生成"));

// 生成基准
const handleGenerate = async () => {
  try {
    // 表单验证
    await formRef.value.validate();

    generating.value = true;

    const params = {
      name: formState.name,
      description: formState.description,
      count: formState.count,
      neighbors_count: formState.neighbors_count,
      embedding_model_id: formState.embedding_model_id,
      llm_config: {
        ...formState.llm_config,
        model_spec: formState.llm_model_spec,
      },
    };

    const response = await evaluationApi.generateBenchmark(props.databaseId, params);

    if (response.message === "success") {
      message.success("生成任务已提交，请稍后查看结果");
      handleCancel();
      emit("success");
    } else {
      message.error(response.message || "生成失败");
    }
  } catch (error) {
    console.error("生成失败:", error);
    message.error("生成失败");
  } finally {
    generating.value = false;
  }
};

// 取消操作
const handleCancel = () => {
  visible.value = false;
  resetForm();
};

// 重置表单
const resetForm = () => {
  formRef.value?.resetFields();
  Object.assign(formState, {
    name: "",
    description: "",
    count: 10,
    neighbors_count: 2,
    embedding_model_id: "",
    llm_model_spec: "",
    llm_config: {
      model: "",
      temperature: 0.7,
      max_tokens: 1000,
    },
  });
  generating.value = false;
};

// 选择LLM模型
const handleSelectLLMModel = (modelSpec) => {
  formState.llm_model_spec = modelSpec;
  formState.llm_config.model = modelSpec;
};

// 监听visible变化
watch(visible, (val) => {
  if (!val) {
    resetForm();
  }
});
</script>

<style lang="less" scoped>
:deep(.ant-card) {
  .ant-card-head {
    min-height: auto;
    padding: 0 12px;
    border-bottom: 1px solid var(--gray-200);

    .ant-card-head-title {
      font-size: 14px;
      padding: 8px 0;
    }
  }
}

</style>
