const express = require('express');
const router = express.Router();
const db = require('../config/database');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

// 加载配置（必须存在 config.yaml）
const configPath = path.join(__dirname, '..', 'config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error('[Pay] 配置文件 config.yaml 不存在，请创建配置文件');
}
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

// 引入系统配置服务（从数据库获取 baseUrl, siteName 等）
const systemConfig = require('../utils/systemConfig');
const autoSettlementService = require('../utils/autoSettlementService');

// ==================== 身份证验证函数 ====================

/**
 * 验证身份证号码格式（18位）
 * @param {string} idCard - 身份证号码
 * @returns {boolean} 是否有效
 */
function isValidIdCard(idCard) {
  if (!idCard || typeof idCard !== 'string') return false;
  
  // 18位身份证正则
  const reg = /^[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/;
  if (!reg.test(idCard)) return false;
  
  // 校验码验证
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(idCard[i]) * weights[i];
  }
  const checkCode = checkCodes[sum % 11];
  return idCard[17].toUpperCase() === checkCode;
}

/**
 * 构建买家身份限制信息
 * @param {Object} params - 请求参数
 * @returns {Object|null} cert_info 对象或 null
 */
function buildCertInfo(params) {
  const { cert_no, cert_name, min_age } = params;
  
  // 验证身份证号码格式
  if (cert_no && !isValidIdCard(cert_no)) {
    return { error: '身份证号码格式不正确' };
  }
  
  // 验证最小年龄格式
  if (min_age !== undefined && min_age !== null && min_age !== '') {
    const age = parseInt(min_age);
    if (isNaN(age) || age < 0) {
      return { error: '最低年龄格式不正确' };
    }
  }
  
  // 如果没有任何身份限制参数，返回 null
  if (!cert_no && !cert_name && (min_age === undefined || min_age === null || min_age === '')) {
    return null;
  }
  
  return {
    cert_no: cert_no || null,
    cert_name: cert_name || null,
    min_age: min_age ? parseInt(min_age) : null
  };
}

// ==================== 支付类型配置 ====================
const payTypes = [
  { id: 1, name: 'alipay', showname: '支付宝', icon: 'alipay.ico', device: 0, status: 1, sort: 1 },
  { id: 2, name: 'wxpay', showname: '微信支付', icon: 'wxpay.ico', device: 0, status: 1, sort: 2 },
  { id: 3, name: 'qqpay', showname: 'QQ钱包', icon: 'qqpay.ico', device: 0, status: 1, sort: 3 },
  { id: 4, name: 'bank', showname: '网银支付', icon: 'bank.ico', device: 0, status: 1, sort: 4 },
  { id: 5, name: 'jdpay', showname: '京东支付', icon: 'jdpay.ico', device: 0, status: 1, sort: 5 },
  { id: 6, name: 'paypal', showname: 'PayPal', icon: 'paypal.ico', device: 0, status: 1, sort: 6 },
  { id: 7, name: 'ecny', showname: '数字人民币', icon: 'ecny.ico', device: 0, status: 1, sort: 7 }
];

function getPayTypeByName(name, device = 'pc') {
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.find(pt => pt.name === name && pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)) || null;
}

function getPayTypeById(id) {
  return payTypes.find(pt => pt.id === id) || null;
}

function getAllPayTypes(device = null) {
  if (!device) return payTypes.filter(pt => pt.status === 1).sort((a, b) => a.sort - b.sort);
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.filter(pt => pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)).sort((a, b) => a.sort - b.sort);
}

const payTypeNames = { alipay: '支付宝', wxpay: '微信支付', qqpay: 'QQ钱包', bank: '网银支付', jdpay: '京东支付', paypal: 'PayPal', ecny: '数字人民币' };

function getPayTypeName(name) { return payTypeNames[name] || name; }
const {
  makeSignMD5,
  verifySignMD5,
  makeSignRSA,
  verifySignRSA,
  generateRSAKeyPair,
  buildCallbackParams,
  sendNotify,
  renderReturnPage
} = require('../utils/payment');
const axios = require('axios');
const pluginLoader = require('../plugins');
const telegramService = require('../Telegram');
const { getClientIp } = require('../utils/ipUtils');

// 加载所有支付插件
pluginLoader.loadAll();

// ==================== 公共函数 ====================

// 获取客户端IP
function getClientIP(req) {
  return getClientIp(req) || req.ip;
}

function logChannelSelectionInfo(message, payload = {}) {
  console.log(`[ChannelSelect] ${message}`, payload);
}

function logChannelSelectionWarn(message, payload = {}) {
  console.warn(`[ChannelSelect] ${message}`, payload);
}

function logChannelSelectionError(message, payload = {}) {
  console.error(`[ChannelSelect] ${message}`, payload);
}

// 通过 PID（12位随机ID）获取商户信息（单服务商模式）
async function getMerchantByPid(pid) {
  const [merchants] = await db.query(
    `SELECT pm.*, pm.fee_rate as merchant_fee_rate, pm.fee_rates as merchant_fee_rates, pm.fee_payer
     FROM merchants pm 
     WHERE pm.pid = ? AND pm.status IN ('active', 'approved')`,
    [pid]
  );
  return merchants[0];
}

/**
 * 验证回调域名是否在商户的白名单中
 * @param {string} merchantId - 商户的 user_id
 * @param {string} notifyUrl - 回调通知地址
 * @returns {Promise<{valid: boolean, message?: string}>}
 */
async function validateCallbackDomain(merchantId, notifyUrl) {
  try {
    // 解析 notify_url 获取域名
    let domain;
    try {
      const url = new URL(notifyUrl);
      domain = url.hostname.toLowerCase();
    } catch (e) {
      return { valid: false, message: '回调地址格式无效' };
    }
    
    // 查询系统配置是否启用域名白名单验证
    let domainWhitelistEnabled = await systemConfig.getConfig('domain_whitelist_enabled');
    // 确保转换为字符串进行比较，防止数据库返回数字类型导致判断失效
    domainWhitelistEnabled = String(domainWhitelistEnabled);

    if (domainWhitelistEnabled !== '1' && domainWhitelistEnabled !== 'true') {
      // 未启用域名白名单验证，直接放行
      return { valid: true };
    }
    
    // 查询商户的已审核通过的域名
    const [approvedDomains] = await db.query(
      'SELECT domain FROM merchant_domains WHERE merchant_id = ? AND status = ?',
      [merchantId, 'approved']
    );
    
    if (approvedDomains.length === 0) {
      return { valid: false, message: '商户未配置已审核的回调域名，请先添加域名白名单' };
    }
    
    // 检查域名是否匹配（支持泛域名匹配）
    const isValid = approvedDomains.some(d => {
      const approvedDomain = d.domain.toLowerCase();
      // 精确匹配
      if (domain === approvedDomain) {
        return true;
      }
      // 泛域名匹配（如 *.example.com 匹配 api.example.com）
      if (approvedDomain.startsWith('*.')) {
        const baseDomain = approvedDomain.slice(2); // 去掉 *.
        if (domain.endsWith('.' + baseDomain)) {
          return true;
        }
      }
      return false;
    });
    
    if (!isValid) {
      return { valid: false, message: `回调域名 ${domain} 不在白名单中` };
    }
    
    return { valid: true };
  } catch (error) {
    console.error('验证回调域名失败:', error);
    // 验证失败时拦截，确保安全
    return { valid: false, message: '系统错误：域名验证失败' };
  }
}

// 通过 pid 获取商户信息（单服务商模式）
async function getMerchant(pid) {
  const [merchants] = await db.query(
    `SELECT pm.*, pm.fee_rate as merchant_fee_rate, pm.fee_rates as merchant_fee_rates, pm.fee_payer
     FROM merchants pm 
     WHERE pm.pid = ? AND pm.status IN ('active', 'approved')`,
    [pid]
  );
  return merchants[0];
}

// 生成12位不重复的PID（API使用）
async function generateUniquePid() {
  let pid;
  let exists = true;
  while (exists) {
    pid = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const [rows] = await db.query('SELECT id FROM merchants WHERE pid = ?', [pid]);
    exists = rows.length > 0;
  }
  return pid;
}

// 获取支付通道（单服务商模式，不按 provider_id 过滤）
async function getChannel(type, payGroupId = null, options = {}) {
  try {
    let channel = null;

    // 指定了支付组时，按支付组配置选通道
    if (payGroupId) {
      channel = await selectChannelFromGroup(type, payGroupId, options);
    } else {
      const [channels] = await db.query(
        `SELECT *, pay_type as type_code, channel_name as type_name,
                min_money as min_amount, max_money as max_amount
         FROM provider_channels
         WHERE FIND_IN_SET(?, pay_type) AND status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
         ORDER BY priority DESC LIMIT 1`,
        [type]
      );
      channel = channels[0] || null;
    }

    if (channel) {
      logChannelSelectionInfo('下单选中通道', {
        payType: type,
        payGroupId: payGroupId || null,
        channelId: channel.id,
        channelName: channel.channel_name || channel.type_name || '',
        plugin: channel.plugin_name || channel.plugin || ''
      });
    } else {
      logChannelSelectionWarn('下单未选到可用通道', {
        payType: type,
        payGroupId: payGroupId || null,
        reason: 'NO_AVAILABLE_CHANNEL'
      });
    }

    return channel;
  } catch (error) {
    logChannelSelectionError('下单选通道异常', {
      payType: type,
      payGroupId: payGroupId || null,
      error: error.message
    });
    throw error;
  }
}

// 获取支付通道列表（单服务商模式）
async function getChannels() {
  const [channels] = await db.query(
    `SELECT *, pay_type as type_code, channel_name as type_name,
            min_money as min_amount, max_money as max_amount
     FROM provider_channels
     WHERE status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY pay_type`
  );
  return channels;
}

/**
 * 获取商户费率
 * 优先级：商户通道独立费率 > 商户统一费率 > 支付组费率
 * 统一格式：数据库存储百分比值（如 6 = 6%），返回小数（如 0.06）
 * @param {Object} merchant - 商户信息（需包含 merchant_fee_rate, merchant_fee_rates, pay_group_id）
 * @param {string} payType - 支付类型名称（如 'alipay', 'wxpay'）
 * @returns {Promise<number>} 费率（小数形式，如 0.06 表示 6%）
 */

/**
 * 智能转换费率为小数形式
 * 兼容新旧格式：
 * - 旧格式（小数）：0.006 表示 0.6%，直接使用
 * - 新格式（百分比）：6 表示 6%，需要 /100
 * 判断依据：如果值 >= 1，认为是百分比格式
 */
function normalizeRateToDecimal(rate) {
  const value = parseFloat(rate);
  if (isNaN(value)) return 0;
  // 如果值 >= 1，说明是百分比格式（如 6 表示 6%），需要 /100
  // 如果值 < 1，说明是小数格式（如 0.06 表示 6%），直接使用
  return value >= 1 ? value / 100 : value;
}

async function getMerchantFeeRate(merchant, payType) {
  // 1. 如果商户有该通道的独立费率，优先使用
  if (merchant.merchant_fee_rates) {
    let feeRates = merchant.merchant_fee_rates;
    if (typeof feeRates === 'string') {
      try { feeRates = JSON.parse(feeRates); } catch (e) { feeRates = null; }
    }
    if (feeRates && feeRates[payType] !== undefined && feeRates[payType] !== null) {
      // 智能兼容新旧格式
      return normalizeRateToDecimal(feeRates[payType]);
    }
  }

  // 2. 如果商户有统一费率，使用统一费率
  if (merchant.merchant_fee_rate !== null && merchant.merchant_fee_rate !== undefined) {
    // 智能兼容新旧格式
    return normalizeRateToDecimal(merchant.merchant_fee_rate);
  }
  
  // 3. 从支付组获取费率（单服务商模式，不按 provider_id 过滤）
  let payGroup = null;
  
  // 优先使用商户指定的支付组
  if (merchant.pay_group_id) {
    const [groups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE id = ?',
      [merchant.pay_group_id]
    );
    if (groups.length > 0) payGroup = groups[0];
  }
  
  // 如果没有指定支付组，使用默认值
  if (!payGroup) {
    const [defaultGroups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    if (defaultGroups.length > 0) payGroup = defaultGroups[0];
  }
  
  // 如果还是没有，取第一个组
  if (!payGroup) {
    const [allGroups] = await db.query(
      'SELECT * FROM provider_pay_groups ORDER BY id LIMIT 1'
    );
    if (allGroups.length > 0) payGroup = allGroups[0];
  }
  
  if (!payGroup || !payGroup.config) {
    return 0; // 没有支付组配置，返回0
  }
  
  // 解析支付组配置
  let config = {};
  try {
    config = typeof payGroup.config === 'string' ? JSON.parse(payGroup.config) : (payGroup.config || {});
  } catch (e) {
    return 0;
  }
  
  // 获取支付类型ID（从配置文件）
  const payTypeInfo = getPayTypeByName(payType);
  
  if (!payTypeInfo) {
    return 0;
  }
  
  const payTypeId = payTypeInfo.id.toString();
  const typeConfig = config[payTypeId];
  
  if (typeConfig && typeConfig.rate !== undefined && typeConfig.rate !== null) {
    // 支付组中的rate 是百分比值（如 6 = 6%），需要转换为小数
    return typeConfig.rate / 100;
  }
  
  return 0;
}

/**
 * 检查支付错误消息是否需要自动关闭通道
 * 当支付插件返回错误消息包含特定关键词时，自动关闭该通道并发送通知
 * @param {string} errorMsg - 错误消息
 * @param {Object} channel - 通道信息
 */
async function checkAndAutoCloseChannel(errorMsg, channel) {
  try {
    if (!errorMsg || !channel) return;
    
    // 获取配置的关键词列表
    const checkPaymsg = await systemConfig.getConfig('check_paymsg', '');
    if (!checkPaymsg) return;
    
    const keywords = checkPaymsg.split('|').filter(k => k.trim());
    if (keywords.length === 0) return;
    
    // 检查错误消息是否包含关键词
    const matchedKeyword = keywords.find(keyword => errorMsg.includes(keyword.trim()));
    if (!matchedKeyword) return;
    
    // 关闭通道
    await db.query('UPDATE provider_channels SET status = 0 WHERE id = ?', [channel.id]);
    console.log(`[通道自动关闭] 通道 ${channel.channel_name || channel.id} 因错误消息 "${matchedKeyword}" 已被自动关闭`);
    
    // 检查是否需要发送通知
    const noticeEnabled = await systemConfig.getConfig('check_paymsg_notice', '0');
    if (noticeEnabled !== '1') return;
    
    // 获取站点名称
    const siteName = await systemConfig.getSiteName();
    
    // 发送 Telegram 通知给管理员
    const title = `${siteName} - 支付通道自动关闭提醒`;
    const content = `尊敬的管理员：\n\n支付通道「${channel.channel_name || channel.id}」因用户下单时出现异常提示「${errorMsg}」，已被系统自动关闭！\n\n匹配关键词：${matchedKeyword}\n通道插件：${channel.plugin_name || '-'}\n\n----------\n${siteName}\n${new Date().toLocaleString('zh-CN')}`;
    
    // 发送通知
    telegramService.notifyAdmins(title + '\n\n' + content);
    
  } catch (error) {
    console.error('[通道自动关闭] 检查错误:', error);
  }
}

// 获取支付组（优先指定ID，其次默认组，最后第一条）
async function getPayGroup(payGroupId = null) {
  let payGroup = null;

  if (payGroupId) {
    const groupId = parseInt(payGroupId, 10);
    if (!isNaN(groupId) && groupId > 0) {
      const [specified] = await db.query(
        'SELECT * FROM provider_pay_groups WHERE id = ? LIMIT 1',
        [groupId]
      );
      payGroup = specified[0] || null;
    }
  }

  if (!payGroup) {
    const [defaults] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    payGroup = defaults[0] || null;
  }

  if (!payGroup) {
    const [allGroups] = await db.query(
      'SELECT * FROM provider_pay_groups ORDER BY id LIMIT 1'
    );
    payGroup = allGroups[0] || null;
  }

  return payGroup;
}

function parsePositiveInt(value) {
  const parsed = parseInt(value, 10);
  return !isNaN(parsed) && parsed > 0 ? parsed : null;
}

function getOrderPayGroupSnapshot(order) {
  return parsePositiveInt(order?.pay_group_id_snapshot);
}

async function resolveMerchantPayGroupId(merchant) {
  const payGroup = await getPayGroup(parsePositiveInt(merchant?.pay_group_id));
  return payGroup?.id || null;
}

// 获取支付类型列表（基于支付组 config）（单服务商模式）
async function getPayTypesByGroups(payGroupId = null) {
  const payGroup = await getPayGroup(payGroupId);
  if (!payGroup || !payGroup.config) {
    return [];
  }

  // 解析 config（键为 pay_types.id，值包含 channel_mode）
  let config = {};
  try {
    config = typeof payGroup.config === 'string' ? JSON.parse(payGroup.config) : (payGroup.config || {});
  } catch (e) {
    return [];
  }

  // 获取所有启用的支付类型 ID（channel_mode !== 0 表示启用）
  const enabledPayTypeIds = Object.entries(config)
    .filter(([id, cfg]) => cfg && cfg.channel_mode !== 0)
    .map(([id]) => parseInt(id, 10))
    .filter(id => !isNaN(id));

  if (enabledPayTypeIds.length === 0) {
    return [];
  }

  // 从配置文件获取启用的支付类型信息
  const allPayTypes = getAllPayTypes();
  const payTypes = allPayTypes
    .filter(pt => enabledPayTypeIds.includes(pt.id))
    .map(pt => ({
      id: pt.id,
      type_code: pt.name,
      type_name: pt.showname,
      icon: pt.icon,
      sort: pt.sort
    }));

  // 检查每个支付类型是否有可用的通道
  const result = [];
  for (const pt of payTypes) {
    const typeConfig = config[pt.id.toString()] || {};

    // 检查该支付类型下是否有启用的通道（单服务商模式）
    const [channels] = await db.query(
      'SELECT id FROM provider_channels WHERE FIND_IN_SET(?, pay_type) AND status = 1 AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1',
      [pt.type_code]
    );

    if (channels.length > 0) {
      result.push({
        type_code: pt.type_code,
        type_name: pt.type_name,
        icon: pt.icon || (pt.type_code + '.ico'),
        pay_type_id: pt.id,
        sort: pt.sort || 999,
        group_id: payGroup.id,
        channel_mode: typeConfig.channel_mode,
        roll_group_id: typeConfig.group_id
      });
    }
  }

  return result.sort((a, b) => a.sort - b.sort);
}

// 创建订单（或复用已存在的未支付订单）
async function createOrder(data) {
  const {
    merchantId,
    channelId,
    tradeNo,
    outTradeNo,
    type,
    name,
    money,
    clientIp,
    device,
    notifyUrl,
    returnUrl,
    feeRate,
    feePayer,
    orderType,
    cryptoPid,
    certInfo,
    payGroupIdSnapshot,
    directMode,
    directLinkId,
    directToken,
    expireAt
  } = data;
  
  // 检查是否已存在相同商户订单号的未支付订单（status=0）
  const [existingOrders] = await db.query(
    'SELECT * FROM orders WHERE merchant_id = ? AND out_trade_no = ? AND status = 0 ORDER BY id DESC LIMIT 1',
    [merchantId, outTradeNo]
  );
  
  // 计算手续费
  const moneyFloat = parseFloat(money);
  const feeMoney = feeRate ? parseFloat((moneyFloat * feeRate).toFixed(2)) : 0;
  const realMoney = feePayer === 'buyer' ? parseFloat((moneyFloat + feeMoney).toFixed(2)) : moneyFloat;
  
  // 处理 certInfo，转换为 JSON 字符串
  const certInfoJson = certInfo ? JSON.stringify(certInfo) : null;
  
  if (existingOrders.length > 0) {
    const existingOrder = existingOrders[0];
    const existingChannelId = existingOrder.channel_id || null;
    const existingPayType = existingOrder.pay_type || null;
    const incomingChannelId = channelId || null;
    const incomingPayType = type || null;
    const isLockedOrder = !!existingChannelId;
    const finalChannelId = isLockedOrder ? existingChannelId : (incomingChannelId || existingChannelId);
    const finalPayType = isLockedOrder ? (existingPayType || incomingPayType) : (incomingPayType || existingPayType);

    if (isLockedOrder && (incomingChannelId || incomingPayType) && (
      String(incomingChannelId || '') !== String(existingChannelId || '') ||
      String(incomingPayType || '') !== String(existingPayType || '')
    )) {
      console.warn('[OrderReuse] 已锁定订单忽略外部通道/类型覆盖', {
        tradeNo: existingOrder.trade_no,
        outTradeNo,
        existingChannelId,
        existingPayType,
        incomingChannelId,
        incomingPayType
      });
    }

    // 复用已存在订单时，锁定订单不允许改 channel_id/pay_type；未锁定则仅在新值存在时更新
    await db.query(
      `UPDATE orders
       SET channel_id = ?, pay_type = ?, notify_url = ?, return_url = ?, fee_money = ?, real_money = ?, fee_payer = ?, cert_info = ?,
           direct_mode = ?, direct_link_id = ?, direct_token = ?, expire_at = ?
       WHERE id = ?`,
      [
        finalChannelId,
        finalPayType,
        notifyUrl,
        returnUrl,
        feeMoney,
        realMoney,
        feePayer || 'merchant',
        certInfoJson,
        directMode || 'none',
        directLinkId || null,
        directToken || null,
        expireAt || null,
        existingOrder.id
      ]
    );
    console.log('复用已存在订单', {
      tradeNo: existingOrder.trade_no,
      outTradeNo,
      feeMoney,
      realMoney,
      feePayer,
      certInfo,
      locked: isLockedOrder,
      channelId: finalChannelId,
      payType: finalPayType
    });
    return { orderId: existingOrder.id, tradeNo: existingOrder.trade_no, isExisting: true };
  }
  
  console.log('创建订单:', { tradeNo, money: moneyFloat, feeRate, feeMoney, realMoney, feePayer, orderType, certInfo });
  
  const [result] = await db.query(
    `INSERT INTO orders (merchant_id, channel_id, trade_no, out_trade_no, pay_type, name, money, real_money, fee_money, fee_payer, client_ip, notify_url, return_url, status, order_type, direct_mode, direct_link_id, direct_token, expire_at, crypto_pid, pay_group_id_snapshot, cert_info, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      merchantId,
      channelId,
      tradeNo,
      outTradeNo,
      type,
      name,
      moneyFloat,
      realMoney,
      feeMoney,
      feePayer || 'merchant',
      clientIp,
      notifyUrl,
      returnUrl,
      orderType || 'normal',
      directMode || 'none',
      directLinkId || null,
      directToken || null,
      expireAt || null,
      cryptoPid || null,
      payGroupIdSnapshot || null,
      certInfoJson
    ]
  );
  return { orderId: result.insertId, tradeNo, isExisting: false };
}

async function closeOrderIfExpired(order) {
  if (!order || order.status !== 0 || !order.expire_at) return false;

  // 使用数据库时间判断，避免 Node 时区解析差异导致“秒过期”
  const [rows] = await db.query(
    'SELECT NOW() >= expire_at AS expired FROM orders WHERE id = ? AND expire_at IS NOT NULL LIMIT 1',
    [order.id]
  );

  if (rows.length === 0 || Number(rows[0].expired) !== 1) return false;

  await db.query('UPDATE orders SET status = 2 WHERE id = ? AND status = 0', [order.id]);
  order.status = 2;
  return true;
}

// 生成订单号
function generateTradeNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return dateStr + random;
}

function formatDateTimeLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

// 获取支付方式显示名称
function getPayTypeName(type) {
  const names = {
    wxpay: '微信支付',
    alipay: '支付宝',
    qqpay: 'QQ钱包',
    bank: '银行卡',
    usdt: 'USDT'
  };
  return names[type] || type;
}

// 验证时间戳（5分钟有效期）
function validateTimestamp(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.abs(now - parseInt(timestamp));
  return diff <= 300; // 5分钟
}

// 获取支付类型（根据method转换）
function getPayTypeFromMethod(type, method, device) {
  // 直接返回type作为支付类型
  // method用于决定返回方式，device用于设备类型判断
  return type;
}

// 生成支付结果响应
function buildPayResponse(version, order, channel, payUrl, payType) {
  if (version === 'v1') {
    // V1响应格式
    return {
      code: 1,
      msg: 'success',
      trade_no: order.trade_no,
      payurl: payUrl,
      qrcode: payType === 'qrcode' ? payUrl : '',
      urlscheme: payType === 'urlscheme' ? payUrl : ''
    };
  } else {
    // V2响应格式
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      code: 0,
      msg: 'success',
      timestamp: timestamp,
      trade_no: order.trade_no,
      money: order.money,
      pay_type: payType, // jump, html, qrcode, urlscheme, jsapi, app, scan, wxplugin, wxapp
      pay_url: payUrl,
      pay_info: payType === 'jsapi' ? payUrl : undefined // JSAPI支付返回的支付参数
    };
  }
}

// 获取测试支付运行时配置
async function getTestPaymentRuntimeConfig() {
  const enabledValue = await systemConfig.getConfig('test_pay_enabled', '0');
  const groupValue = await systemConfig.getConfig('test_pay_group_id', '');
  const maxAmountValue = await systemConfig.getConfig('test_pay_max_amount', '50000');
  const autoRefundValue = await systemConfig.getConfig('test_pay_auto_refund', '0');
  const parsedGroupId = parseInt(groupValue, 10);
  const parsedMaxAmount = parseFloat(maxAmountValue);

  return {
    enabled: String(enabledValue) === '1',
    payGroupId: !isNaN(parsedGroupId) && parsedGroupId > 0 ? parsedGroupId : null,
    maxAmount: !isNaN(parsedMaxAmount) && parsedMaxAmount > 0 ? parseFloat(parsedMaxAmount.toFixed(2)) : 50000,
    autoRefund: String(autoRefundValue) === '1'
  };
}

const TEST_PAY_VISITOR_SECRET = String(
  (config && config.turnstile && config.turnstile.secretKey) || 'epay-test-pay-visitor-sign-secret'
);

function normalizeTestVisitorId(visitorId) {
  return typeof visitorId === 'string' ? visitorId.trim() : '';
}

function isValidTestVisitorId(visitorId) {
  return /^[A-Za-z0-9_-]{16,80}$/.test(visitorId);
}

function signTestOrderVisitor(tradeNo, visitorId) {
  return crypto
    .createHmac('sha256', TEST_PAY_VISITOR_SECRET)
    .update(`${tradeNo}|${visitorId}`)
    .digest('hex');
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseOrderParam(rawParam) {
  if (!rawParam) {
    return {};
  }
  if (typeof rawParam === 'object' && !Array.isArray(rawParam)) {
    return rawParam;
  }
  if (typeof rawParam !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(rawParam);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function verifyTestOrderVisitorAccess(order, visitorId, visitorSig) {
  if (!order || order.order_type !== 'test') {
    return { ok: true };
  }

  const orderParam = parseOrderParam(order.param);
  const savedVisitorId = normalizeTestVisitorId(orderParam?.test_pay?.visitor_id);

  // 兼容历史测试订单：若未记录访客标识，则不强制拦截
  if (!savedVisitorId) {
    return { ok: true };
  }

  const currentVisitorId = normalizeTestVisitorId(visitorId);
  const currentVisitorSig = typeof visitorSig === 'string' ? visitorSig.trim() : '';
  if (!isValidTestVisitorId(currentVisitorId) || !currentVisitorSig) {
    return { ok: false };
  }

  const expectedSig = signTestOrderVisitor(order.trade_no, savedVisitorId);
  if (currentVisitorId !== savedVisitorId || !safeEqualString(currentVisitorSig, expectedSig)) {
    return { ok: false };
  }

  return { ok: true, visitorId: savedVisitorId, visitorSig: expectedSig };
}

// ==================== V2 接口（兼容入口）===================

// V2 统一下单 - 委托统一处理逻辑
router.all('/v2/create', async (req, res) => {
  return handleMapi(req, res);
});

// V2 订单查询
router.all('/v2/query', async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, trade_no, out_trade_no, sign, timestamp } = params;

    if (!pid || !sign || !timestamp) {
      return res.json({ code: 1001, msg: '缺少必要参数' });
    }

    if (!trade_no && !out_trade_no) {
      return res.json({ code: 1001, msg: '订单号不能为空' });
    }

    // 验证时间戳
    if (!validateTimestamp(timestamp)) {
      return res.json({ code: 1002, msg: '时间戳已过期' });
    }

    // 获取商户信息
    const merchant = await getMerchant(pid);
    if (!merchant) {
      return res.json({ code: 1003, msg: '商户不存在或已禁止' });
    }

    // 验证签名
    const signParams = { pid, timestamp };
    if (trade_no) signParams.trade_no = trade_no;
    if (out_trade_no) signParams.out_trade_no = out_trade_no;

    let signValid = false;
    if (merchant.rsa_public_key) {
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    if (!signValid) {
      return res.json({ code: 1004, msg: '签名验证失败' });
    }

    // 查询订单
    let query = 'SELECT * FROM orders WHERE merchant_id = ?';
    const queryParams = [merchant.user_id];  // orders.merchant_id 存储的是 users.id
    
    if (trade_no) {
      query += ' AND trade_no = ?';
      queryParams.push(trade_no);
    } else {
      query += ' AND out_trade_no = ?';
      queryParams.push(out_trade_no);
    }

    const [orders] = await db.query(query, queryParams);
    
    if (orders.length === 0) {
      return res.json({ code: 1008, msg: '订单不存在' });
    }

    const order = orders[0];
    const statusMap = { 'pending': 0, 'paid': 1, 'closed': 2, 'refunded': 3 };

    const responseTimestamp = Math.floor(Date.now() / 1000);
    const responseData = {
      code: 0,
      msg: 'success',
      timestamp: responseTimestamp,
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      type: order.pay_type,
      name: order.name,
      money: parseFloat(order.money).toFixed(2),
      status: statusMap[order.status] || 0,
      create_time: order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : 0,
      pay_time: order.paid_at ? Math.floor(new Date(order.paid_at).getTime() / 1000) : 0
    };

    // 响应签名
    if (merchant.rsa_private_key) {
      const signData = { 
        trade_no: order.trade_no, 
        out_trade_no: order.out_trade_no,
        status: statusMap[order.status] || 0,
        timestamp: responseTimestamp
      };
      responseData.sign = makeSignRSA(signData, merchant.rsa_private_key);
    }

    res.json(responseData);

  } catch (error) {
    console.error('V2 Query Error:', error);
    res.json({ code: 9999, msg: '系统错误' });
  }
});

// ==================== 公共接口 ====================

// 获取测试支付配置（公开）
router.get('/test/config', async (req, res) => {
  try {
    const testRuntime = await getTestPaymentRuntimeConfig();

    if (!testRuntime.enabled) {
      return res.json({
        code: 0,
        msg: 'success',
        data: {
          enabled: false,
          reason: '测试支付未开启',
          pay_group_id: testRuntime.payGroupId,
          pay_group_name: '',
          max_amount: testRuntime.maxAmount,
          auto_refund: testRuntime.autoRefund,
          pay_types: []
        }
      });
    }

    if (!testRuntime.payGroupId) {
      return res.json({
        code: 0,
        msg: 'success',
        data: {
          enabled: false,
          reason: '测试支付未配置支付组',
          pay_group_id: null,
          pay_group_name: '',
          max_amount: testRuntime.maxAmount,
          auto_refund: testRuntime.autoRefund,
          pay_types: []
        }
      });
    }

    const [groups] = await db.query(
      'SELECT id, name FROM provider_pay_groups WHERE id = ? LIMIT 1',
      [testRuntime.payGroupId]
    );

    if (groups.length === 0) {
      return res.json({
        code: 0,
        msg: 'success',
        data: {
          enabled: false,
          reason: '测试支付组不存在',
          pay_group_id: testRuntime.payGroupId,
          pay_group_name: '',
          max_amount: testRuntime.maxAmount,
          auto_refund: testRuntime.autoRefund,
          pay_types: []
        }
      });
    }

    const payTypes = await getPayTypesByGroups(testRuntime.payGroupId);

    if (payTypes.length === 0) {
      return res.json({
        code: 0,
        msg: 'success',
        data: {
          enabled: false,
          reason: '测试支付组暂无可用通道',
          pay_group_id: testRuntime.payGroupId,
          pay_group_name: groups[0].name || '',
          max_amount: testRuntime.maxAmount,
          auto_refund: testRuntime.autoRefund,
          pay_types: []
        }
      });
    }

    res.json({
      code: 0,
      msg: 'success',
      data: {
        enabled: true,
        reason: '',
        pay_group_id: testRuntime.payGroupId,
        pay_group_name: groups[0].name || '',
        max_amount: testRuntime.maxAmount,
        auto_refund: testRuntime.autoRefund,
        pay_types: payTypes
      }
    });
  } catch (error) {
    console.error('Get Test Pay Config Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
});

// 创建测试支付订单（公开）
router.post('/test/create', async (req, res) => {
  try {
    const { money, pay_type, name, visitor_id, direct_pay } = req.body || {};
    const testRuntime = await getTestPaymentRuntimeConfig();

    if (!testRuntime.enabled) {
      return res.json({ code: 1, msg: '测试支付未开启' });
    }
    if (!testRuntime.payGroupId) {
      return res.json({ code: 1, msg: '测试支付未配置支付组' });
    }
    if (!pay_type) {
      return res.json({ code: 1, msg: '请选择支付方式' });
    }

    const visitorId = normalizeTestVisitorId(visitor_id);
    if (!isValidTestVisitorId(visitorId)) {
      return res.json({ code: 1, msg: '访客标识无效，请刷新页面后重试' });
    }

    const payTypes = await getPayTypesByGroups(testRuntime.payGroupId);
    if (payTypes.length === 0) {
      return res.json({ code: 1, msg: '测试支付组暂无可用通道' });
    }

    const selectedPayType = payTypes.find((pt) => pt.type_code === pay_type);
    if (!selectedPayType) {
      return res.json({ code: 1, msg: '当前支付方式不在测试支付组中' });
    }

    const moneyFloat = parseFloat(money);
    if (isNaN(moneyFloat) || moneyFloat <= 0) {
      return res.json({ code: 1, msg: '金额不合法' });
    }
    if (moneyFloat > testRuntime.maxAmount) {
      return res.json({ code: 1, msg: `金额不能超过 ${testRuntime.maxAmount.toFixed(2)} 元` });
    }

    // 测试支付不绑定真实商户，费率仅按测试支付组计算
    const merchantForFee = {
      merchant_fee_rate: null,
      merchant_fee_rates: null,
      fee_payer: 'merchant',
      pay_group_id: testRuntime.payGroupId
    };

    const feeRate = await getMerchantFeeRate(merchantForFee, pay_type);
    const feePayer = merchantForFee.fee_payer || 'merchant';

    const tradeNo = generateTradeNo();
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    const visitorSig = signTestOrderVisitor(tradeNo, visitorId);
    const returnUrl = `${baseUrl}/test-pay?ok=1&trade_no=${tradeNo}&visitor_id=${encodeURIComponent(visitorId)}&visitor_sig=${visitorSig}`;

    const orderResult = await createOrder({
      merchantId: null,
      channelId: null,
      tradeNo,
      outTradeNo: tradeNo,
      type: pay_type,
      name: (name && String(name).trim()) || '支付测试',
      money: parseFloat(moneyFloat.toFixed(2)),
      clientIp: getClientIP(req),
      device: 'pc',
      notifyUrl: '',
      returnUrl,
      feeRate,
      feePayer,
      orderType: 'test',
      payGroupIdSnapshot: testRuntime.payGroupId
    });

    const cashierUrl = `${baseUrl}/api/pay/cashier?trade_no=${orderResult.tradeNo}&pay_type=${encodeURIComponent(pay_type)}`;

    // 复用 param 字段记录测试订单访客标识（不新增数据库列）
    const [orderRows] = await db.query('SELECT param FROM orders WHERE id = ? LIMIT 1', [orderResult.orderId]);
    const orderParam = orderRows.length > 0 ? parseOrderParam(orderRows[0].param) : {};
    orderParam.test_pay = {
      visitor_id: visitorId,
      signed_at: Date.now(),
      marker: 'test_payment'
    };
    await db.query('UPDATE orders SET param = ? WHERE id = ?', [JSON.stringify(orderParam), orderResult.orderId]);

    const directPayEnabled = direct_pay === true || direct_pay === 1 || direct_pay === '1';
    let payResult = null;

    if (directPayEnabled) {
      try {
        const dopayResponse = await fetch(`${baseUrl}/api/pay/dopay`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            trade_no: orderResult.tradeNo,
            pay_type,
            group_id: testRuntime.payGroupId
          })
        });

        if (dopayResponse.ok) {
          payResult = await dopayResponse.json();
        } else {
          const rawText = await dopayResponse.text();
          payResult = {
            code: 1,
            msg: rawText || `支付发起失败（HTTP ${dopayResponse.status}）`
          };
        }
      } catch (dopayError) {
        console.error('Create Test Pay Direct DoPay Error:', dopayError);
        payResult = {
          code: 1,
          msg: '支付发起失败，请稍后重试'
        };
      }
    }

    if (payResult && payResult.code !== 0) {
      return res.json({
        code: 1,
        msg: payResult.msg || '支付发起失败',
        data: {
          trade_no: orderResult.tradeNo,
          cashier_url: cashierUrl,
          pay_type,
          visitor_id: visitorId,
          visitor_sig: visitorSig,
          pay_result: payResult
        }
      });
    }

    res.json({
      code: 0,
      msg: 'success',
      data: {
        trade_no: orderResult.tradeNo,
        cashier_url: cashierUrl,
        pay_type,
        visitor_id: visitorId,
        visitor_sig: visitorSig,
        pay_result: payResult
      }
    });
  } catch (error) {
    console.error('Create Test Pay Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
});

// 直接收款创建订单（公开）
router.post('/direct/create-order', async (req, res) => {
  try {
    const directPayFeatureEnabled = (await systemConfig.getConfig('direct_pay_feature_enabled', '1')) === '1';
    if (!directPayFeatureEnabled) {
      return res.json({ code: 1, msg: '系统已关闭直接收款功能' });
    }

    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const moneyRaw = req.body.money;

    if (!token || !/^[A-Za-z0-9]{24}$|^[A-Za-z0-9]{32}$/.test(token)) {
      return res.json({ code: 1, msg: '收款链接无效' });
    }

    let merchant = null;
    let directMode = 'default';
    let directLinkId = null;
    let directToken = token;
    let expireAt = null;
    let orderMoney = parseFloat(moneyRaw);

    if (token.length === 24) {
      const [rows] = await db.query(
        `SELECT u.id AS user_id, u.direct_pay_enabled, m.notify_url, m.return_url, m.status, m.fee_rate AS merchant_fee_rate,
                m.fee_rates AS merchant_fee_rates, m.fee_payer, m.pay_group_id
         FROM users u
         INNER JOIN merchants m ON m.user_id = u.id
         WHERE u.direct_pay_token = ?
         LIMIT 1`,
        [token]
      );

      if (rows.length === 0) {
        return res.json({ code: 1, msg: '收款链接不存在' });
      }

      merchant = rows[0];
      if (merchant.direct_pay_enabled !== 1) {
        return res.json({ code: 1, msg: '该商户未启用直接收款' });
      }

      if (!Number.isFinite(orderMoney) || orderMoney <= 0) {
        return res.json({ code: 1, msg: '请输入正确金额' });
      }
    } else {
      directMode = 'fixed';
      const [rows] = await db.query(
        `SELECT dl.id, dl.merchant_user_id, dl.fixed_amount, dl.expire_hours, dl.usage_mode, dl.expires_at, dl.is_enabled,
                m.notify_url, m.return_url, m.status, m.fee_rate AS merchant_fee_rate,
                m.fee_rates AS merchant_fee_rates, m.fee_payer, m.pay_group_id
         FROM direct_links dl
         INNER JOIN merchants m ON m.user_id = dl.merchant_user_id
         WHERE dl.token = ?
         LIMIT 1`,
        [token]
      );

      if (rows.length === 0) {
        return res.json({ code: 1, msg: '固定金额链接不存在' });
      }

      const fixedLink = rows[0];
      if (fixedLink.is_enabled !== 1) {
        return res.json({ code: 1, msg: '该固定金额链接已停用' });
      }
      const [fixedExpireRows] = await db.query(
        'SELECT NOW() >= expires_at AS expired FROM direct_links WHERE id = ? AND expires_at IS NOT NULL LIMIT 1',
        [fixedLink.id]
      );
      if (!fixedLink.expires_at || fixedExpireRows.length === 0 || Number(fixedExpireRows[0].expired) === 1) {
        return res.json({ code: 1, msg: '该固定金额链接已过期' });
      }

      merchant = {
        ...fixedLink,
        user_id: fixedLink.merchant_user_id
      };
      directLinkId = fixedLink.id;
      orderMoney = parseFloat(fixedLink.fixed_amount);
      // 直接沿用数据库读取值，避免 Node 本地时区格式化导致偏移
      expireAt = fixedLink.expires_at;
    }

    if (!merchant || !['active', 'approved'].includes(merchant.status)) {
      return res.json({ code: 1, msg: '商户状态不可用' });
    }

    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');

    if (directMode === 'fixed' && directLinkId) {
      const usageMode = merchant.usage_mode || 'single_use';
      if (usageMode === 'single_use') {
        const [paidRows] = await db.query(
          `SELECT trade_no
           FROM orders
           WHERE merchant_id = ? AND direct_mode = 'fixed' AND direct_link_id = ? AND status = 1
           ORDER BY paid_at DESC, id DESC
           LIMIT 1`,
          [merchant.user_id, directLinkId]
        );

        if (paidRows.length > 0) {
          const paidTradeNo = paidRows[0].trade_no;
          const successUrl = `${protocol}://${host}/api/pay/success?trade_no=${encodeURIComponent(paidTradeNo)}`;
          return res.json({
            code: 0,
            msg: 'success',
            data: {
              trade_no: paidTradeNo,
              success_url: successUrl
            }
          });
        }
      }

      const [existingRows] = await db.query(
        `SELECT trade_no, expire_at
         FROM orders
         WHERE merchant_id = ? AND direct_mode = 'fixed' AND direct_link_id = ? AND status = 0
         ORDER BY id DESC
         LIMIT 1`,
        [merchant.user_id, directLinkId]
      );

      if (existingRows.length > 0) {
        const existingOrder = existingRows[0];
        const [existingExpireRows] = await db.query(
          'SELECT NOW() >= expire_at AS expired FROM orders WHERE trade_no = ? AND status = 0 AND expire_at IS NOT NULL LIMIT 1',
          [existingOrder.trade_no]
        );
        const isExpired = !existingOrder.expire_at || existingExpireRows.length === 0 || Number(existingExpireRows[0].expired) === 1;

        if (isExpired) {
          await db.query('UPDATE orders SET status = 2 WHERE trade_no = ? AND status = 0', [existingOrder.trade_no]);
        } else {
          const cashierUrl = `${protocol}://${host}/api/pay/cashier?trade_no=${existingOrder.trade_no}`;
          return res.json({
            code: 0,
            msg: 'success',
            data: {
              trade_no: existingOrder.trade_no,
              cashier_url: cashierUrl
            }
          });
        }
      }
    }

    const tradeNo = generateTradeNo();
    const outTradeNo = `direct_${tradeNo}`;

    const feeRate = await getMerchantFeeRate(merchant, null);
    const orderResult = await createOrder({
      merchantId: merchant.user_id,
      channelId: null,
      tradeNo,
      outTradeNo,
      type: null,
      name: directMode === 'fixed' ? '固定金额直接收款' : '直接收款',
      money: parseFloat(orderMoney.toFixed(2)),
      clientIp: getClientIP(req),
      device: 'pc',
      notifyUrl: merchant.notify_url || '',
      returnUrl: merchant.return_url || '',
      feeRate,
      feePayer: merchant.fee_payer || 'merchant',
      orderType: 'normal',
      payGroupIdSnapshot: merchant.pay_group_id || null,
      directMode,
      directLinkId,
      directToken,
      expireAt
    });

    const cashierUrl = `${protocol}://${host}/api/pay/cashier?trade_no=${orderResult.tradeNo}`;

    return res.json({
      code: 0,
      msg: 'success',
      data: {
        trade_no: orderResult.tradeNo,
        cashier_url: cashierUrl
      }
    });
  } catch (error) {
    console.error('Direct Create Order Error:', error);
    return res.json({ code: -1, msg: '创建订单失败' });
  }
});

// 取消测试支付订单（公开，仅当前访客可取消自己的未支付测试订单）
router.post('/test/cancel', async (req, res) => {
  try {
    const { trade_no, visitor_id, visitor_sig } = req.body || {};
    const tradeNo = typeof trade_no === 'string' ? trade_no.trim() : '';

    if (!tradeNo) {
      return res.json({ code: 1, msg: '订单号不能为空' });
    }

    const [orders] = await db.query(
      'SELECT id, trade_no, status, order_type, param FROM orders WHERE trade_no = ? LIMIT 1',
      [tradeNo]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];

    if (await closeOrderIfExpired(order)) {
      return res.render('error', { message: '订单已过期', code: 'ORDER_EXPIRED', backUrl: null });
    }
    if (order.order_type !== 'test') {
      return res.json({ code: 1, msg: '仅测试订单支持取消' });
    }

    const accessResult = verifyTestOrderVisitorAccess(order, visitor_id, visitor_sig);
    if (!accessResult.ok) {
      return res.status(403).json({ code: 1, msg: '无权取消该订单' });
    }

    if (order.status === 1) {
      return res.json({ code: 1, msg: '订单已支付，无法取消' });
    }

    if (order.status !== 0) {
      return res.json({ code: 0, msg: '订单已关闭' });
    }

    const [updateResult] = await db.query(
      'UPDATE orders SET status = 2 WHERE id = ? AND status = 0',
      [order.id]
    );

    if (updateResult.affectedRows === 0) {
      const [latest] = await db.query('SELECT status FROM orders WHERE id = ? LIMIT 1', [order.id]);
      if (latest.length > 0 && latest[0].status === 1) {
        return res.json({ code: 1, msg: '订单已支付，无法取消' });
      }
      return res.json({ code: 1, msg: '订单状态已变化，请刷新后重试' });
    }

    return res.json({ code: 0, msg: '订单已取消' });
  } catch (error) {
    console.error('Cancel Test Order Error:', error);
    return res.json({ code: -1, msg: '系统错误' });
  }
});

// 收银台页面
router.get('/cashier', async (req, res) => {
  try {
    const { trade_no } = req.query;
    const requestedPayType = typeof req.query.pay_type === 'string' ? req.query.pay_type.trim() : '';

    if (!trade_no) {
      return res.status(400).send('订单号不能为空');
    }

    // 查询订单
    const [orders] = await db.query(
      `SELECT o.*, u.merchant_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.merchant_id
       WHERE o.trade_no = ?`,
      [trade_no]
    );

    if (orders.length === 0) {
      return res.status(404).send('订单不存在');
    }

    const order = orders[0];

    if (await closeOrderIfExpired(order)) {
      return res.json({ code: 1, msg: '订单已过期' });
    }

    // 状态: 0=待支付 1=已支付 2=已关闭
    if (order.status !== 0) {
      if (order.status === 1) {
        return res.redirect(`/api/pay/success?trade_no=${trade_no}`);
      } else {
        return res.render('error', { message: '订单状态异常', code: 'ORDER_STATUS_ERROR', backUrl: null });
      }
    }

    // 检查订单是否已经选择了通道（channel_id 存在）
    // 如果已选择通道，直接显示二维码页面，不允许重新选择
    let lockedPayment = null;
    if (order.channel_id) {
      // 订单已锁定通道，获取通道信息生成二维码
      const [channels] = await db.query(
        'SELECT * FROM provider_channels WHERE id = ?',
        [order.channel_id]
      );
      
      if (channels.length > 0) {
        const channel = channels[0];
        const orderParam = parseOrderParam(order.param);
        const cachedLockedPayType = orderParam && orderParam.dopay_cache && typeof orderParam.dopay_cache.pay_type === 'string'
          ? orderParam.dopay_cache.pay_type.trim()
          : '';
        const channelPayTypes = typeof channel.pay_type === 'string'
          ? channel.pay_type.split(',').map((item) => item.trim()).filter(Boolean)
          : [];
        let lockedPayType = typeof order.pay_type === 'string' ? order.pay_type.trim() : '';

        if (!lockedPayType && cachedLockedPayType) {
          lockedPayType = cachedLockedPayType;
        }
        if (!lockedPayType && requestedPayType && channelPayTypes.includes(requestedPayType)) {
          lockedPayType = requestedPayType;
        }
        if (!lockedPayType && channelPayTypes.length === 1) {
          lockedPayType = channelPayTypes[0];
        }

        if (!lockedPayType) {
          console.warn('[Cashier] 锁定通道订单缺少可用 pay_type', {
            tradeNo: order.trade_no,
            orderId: order.id,
            channelId: order.channel_id,
            channelName: channel.channel_name,
            channelPayTypes,
            cachedLockedPayType,
            requestedPayType
          });
          return res.render('error', {
            message: '订单已锁定通道但缺少支付方式，请联系客服处理',
            code: 'LOCKED_ORDER_PAY_TYPE_MISSING',
            backUrl: null
          });
        }

        if (order.pay_type !== lockedPayType) {
          await db.query('UPDATE orders SET pay_type = ? WHERE id = ?', [lockedPayType, order.id]);
          order.pay_type = lockedPayType;
        }

        lockedPayment = {
          channel_id: order.channel_id,
          pay_type: lockedPayType,
          plugin_name: channel.plugin_name,
          channel_name: channel.channel_name
        };
      }
    }

    // 测试订单已在测试页选定支付方式时，直接锁定该方式并自动拉起支付
    if (!lockedPayment && order.order_type === 'test' && order.pay_type) {
      lockedPayment = {
        channel_id: null,
        pay_type: order.pay_type,
        plugin_name: '',
        channel_name: '测试支付已选方式'
      };
    }

    let payTypes = [];
    let selectedGroupId = '';
    let forcedGroupId = null;

    if (order.order_type === 'test') {
      const testRuntime = await getTestPaymentRuntimeConfig();
      forcedGroupId = testRuntime.payGroupId;
      if (!forcedGroupId) {
        return res.render('error', { message: '测试支付未配置支付组', code: 'TEST_PAY_GROUP_MISSING', backUrl: '/' });
      }
    } else {
      // 新订单优先读取下单时的支付组快照；旧订单为空时保持历史默认行为
      forcedGroupId = getOrderPayGroupSnapshot(order);
    }

    // 获取服务商配置的支付类型列表
    payTypes = await getPayTypesByGroups(forcedGroupId);

    // 收银台允许通过 query 传入 pay_type，命中可用类型时写回订单（仅未锁定订单）
    let autoPayType = '';
    if (requestedPayType && lockedPayment) {
      if (requestedPayType !== lockedPayment.pay_type) {
        console.warn('[Cashier] 已锁定订单忽略外部 pay_type', {
          tradeNo: order.trade_no,
          orderId: order.id,
          requestedPayType,
          lockedPayType: lockedPayment.pay_type,
          channelId: lockedPayment.channel_id,
          channelName: lockedPayment.channel_name
        });
      }
    } else if (requestedPayType) {
      const matchedPayType = payTypes.find((p) => p.type_code === requestedPayType);
      if (matchedPayType) {
        if (order.pay_type !== requestedPayType) {
          await db.query('UPDATE orders SET pay_type = ? WHERE id = ?', [requestedPayType, order.id]);
          order.pay_type = requestedPayType;
        }
        autoPayType = requestedPayType;
      } else {
        console.warn(`[Cashier] 拒绝无效 pay_type 参数: trade_no=${trade_no}, pay_type=${requestedPayType}`);
        return res.render('error', {
          message: '指定支付方式不可用，请返回重试',
          code: 'PAY_TYPE_NOT_AVAILABLE',
          backUrl: null
        });
      }
    }

    // 计算当前选中的支付方式对应的 group_id
    if (forcedGroupId) {
      selectedGroupId = String(forcedGroupId);
    } else {
      const currentPayType = payTypes.find(p => p.type_code === order.pay_type);
      selectedGroupId = currentPayType ? (currentPayType.group_id || '') : '';
    }

    // 处理页面订单名称（pageordername 配置）
    const pageOrderName = await systemConfig.getConfig('page_order_name', '0');
    const orderNameTemplate = await systemConfig.getConfig('order_name_template', '');
    let displayOrderName = order.name;
    
    if (pageOrderName === '1') {
      // 启用了页面订单名称隐藏
      if (orderNameTemplate) {
        displayOrderName = systemConfig.replaceOrderName(orderNameTemplate, {
          name: order.name,
          trade_no: order.trade_no,
          out_trade_no: order.out_trade_no,
          merchant_id: order.merchant_id
        });
      } else {
        displayOrderName = '在线支付';  // 默认名称
      }
    }

    let testVisitorId = '';
    let testVisitorSig = '';
    if (order.order_type === 'test') {
      const orderParam = parseOrderParam(order.param);
      const savedVisitorId = normalizeTestVisitorId(orderParam?.test_pay?.visitor_id);
      if (savedVisitorId) {
        testVisitorId = savedVisitorId;
        testVisitorSig = signTestOrderVisitor(order.trade_no, savedVisitorId);
      }
    }

    const lockedAutoPayType = lockedPayment && lockedPayment.pay_type ? lockedPayment.pay_type : '';

    // 传入 pay_type 或订单已锁定通道时，启用直连模式（复用 cashier.ejs 的统一UI模板）
    if ((requestedPayType && autoPayType) || lockedPayment) {
      const displayMerchantName = (order.merchant_name || '').trim() || '在线支付';
      return res.render('cashier', {
        order: { ...order, display_name: displayOrderName },
        payTypes,
        selectedGroupId,
        autoPayType: lockedAutoPayType || autoPayType,
        directMode: true,
        sitename: displayMerchantName,
        isCrypto: false,
        lockedPayment,
        testVisitorId,
        testVisitorSig
      });
    }

    const displayMerchantName = (order.merchant_name || '').trim() || '在线支付';
    // 渲染收银台页面（使用 EJS 模板）
    res.render('cashier', {
      order: { ...order, display_name: displayOrderName },  // 添加显示名称
      payTypes,
      selectedGroupId,
      autoPayType: '',
      directMode: false,
      sitename: displayMerchantName,
      isCrypto: false,
      lockedPayment,  // 传递锁定的支付信息
      testVisitorId,
      testVisitorSig
    });

  } catch (error) {
    console.error('Cashier Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

// 选择支付类型（用户在收银台选择支付方式时调用）
router.post('/select_channel', async (req, res) => {
  try {
    const { trade_no, pay_type } = req.body;

    if (!trade_no) {
      return res.json({ code: 1, msg: '订单号不能为空' });
    }

    if (!pay_type) {
      return res.json({ code: 1, msg: '未选择支付类型' });
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 只有待支付订单可以修改
    if (order.status !== 0) {
      return res.json({ code: 1, msg: '订单状态异常' });
    }

    // 已锁定通道的订单不允许切换支付方式
    if (order.channel_id) {
      return res.json({ code: 1, msg: '订单已锁定通道，不能切换支付方式' });
    }

    // 测试订单只能选择测试支付组内的支付方式
    if (order.order_type === 'test') {
      const testRuntime = await getTestPaymentRuntimeConfig();
      if (!testRuntime.payGroupId) {
        return res.json({ code: 1, msg: '测试支付未配置支付组' });
      }

      const testPayTypes = await getPayTypesByGroups(testRuntime.payGroupId);
      const inTestGroup = testPayTypes.some(pt => pt.type_code === pay_type);
      if (!inTestGroup) {
        return res.json({ code: 1, msg: '该支付方式不在测试支付组中' });
      }
    }

    // 只更新 pay_type（通道会在 dopay 时根据组配置选择）
    await db.query(
      'UPDATE orders SET pay_type = ? WHERE id = ?',
      [pay_type, order.id]
    );

    res.json({ code: 0, msg: '已选择支付类型' });
  } catch (error) {
    console.error('Select Channel Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
});

// 根据支付组配置选择通道（单服务商模式）
/**
 * 从支付组中选择通道
 * @param {string} payType - 支付类型
 * @param {number|null} payGroupId - 支付组ID
 * @param {Object} options - 可选参数
 * @param {number|null} options.minAge - 商户要求的最小年龄，用于过滤通道
 */
async function selectChannelFromGroup(payType, payGroupId = null, options = {}) {
  const { minAge = null } = options;
  let payGroup;
  const requestedPayGroupId = parsePositiveInt(payGroupId);
  
  // 如果传入的 payGroupId，优先使用 
  if (requestedPayGroupId) {
    const [groups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE id = ?',
      [requestedPayGroupId]
    );
    payGroup = groups[0];
    if (!payGroup) {
      console.warn(`[PayGroupFallback] 指定支付组不存在，回退默认组: payType=${payType}, payGroupId=${requestedPayGroupId}`);
    }
  }
  
  // 如果没有找到，查询默认支付组
  if (!payGroup) {
    const [payGroups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    payGroup = payGroups[0];
    if (payGroup && requestedPayGroupId) {
      console.warn(`[PayGroupFallback] 已回退到默认支付组: payType=${payType}, defaultGroupId=${payGroup.id}`);
    }
  }
  
  if (!payGroup) {
    const [allGroups] = await db.query(
      'SELECT * FROM provider_pay_groups ORDER BY id LIMIT 1'
    );
    payGroup = allGroups[0];
  }

  if (!payGroup) {
    logChannelSelectionWarn('支付组选择失败：未找到可用支付组', {
      payType,
      requestedPayGroupId: requestedPayGroupId || null,
      reason: 'PAY_GROUP_NOT_FOUND'
    });
    return null;
  }
  
  // 获取支付类型 ID（从配置文件）
  const payTypeInfo = getPayTypeByName(payType);
  const payTypeId = payTypeInfo?.id;
  
  // 解析 config
  let config = {};
  if (payGroup?.config) {
    try {
      config = typeof payGroup.config === 'string' ? JSON.parse(payGroup.config) : (payGroup.config || {});
    } catch (e) {
      config = {};
    }
  }
  
  // 获取该支付类型的配置
  const typeConfig = payTypeId ? config[payTypeId.toString()] : null;

  // 支付组未配置该支付方式时，视为不可用，避免错误回退到全局随机通道
  if (!typeConfig) {
    logChannelSelectionWarn('支付组选择失败：支付组未配置该支付方式', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      payTypeId,
      reason: 'PAY_TYPE_NOT_CONFIGURED_IN_GROUP'
    });
    return null;
  }
  
  // 如果该支付类型被关闭或未配置
  if (typeConfig && typeConfig.channel_mode === 0) {
    logChannelSelectionWarn('支付组选择失败：该支付方式在支付组中被关闭', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      reason: 'PAY_TYPE_DISABLED_IN_GROUP'
    });
    return null;
  }
  
  // 根据 channel_mode 决定选择策略
  const mode = typeConfig?.channel_mode ?? -1; // 默认随机
  
  // channel_mode: 0=关闭, -1=随机, -4=顺序轮询, -5=首个可用, -3=使用轮询组） >0=指定通道ID
  
  // 如果使用轮询组，优先处理（轮询组可包含任意通道，不限支付方式）
  if (mode === -3 && typeConfig?.group_id) {
    const [groups] = await db.query(
      'SELECT * FROM channel_groups WHERE id = ? AND status = 1',
      [typeConfig.group_id]
    );
    if (groups.length > 0) {
      const group = groups[0];
      let groupChannels = [];
      try {
        groupChannels = typeof group.channels === 'string' ? JSON.parse(group.channels) : (group.channels || []);
      } catch (e) {
        groupChannels = [];
      }
      if (groupChannels.length > 0) {
        // 获取轮询组中所有通道的详细信息（用于 minAge 过滤）
        const channelIds = groupChannels.map(c => c.id);
        const [allGroupChannels] = await db.query(
          `SELECT *, pay_type as type_code, channel_name as type_name
           FROM provider_channels 
           WHERE id IN (?) AND status = 1`,
          [channelIds]
        );
        
        // 如果商户传入了 minAge，过滤掉 force_min_age > minAge 的通道
        let eligibleChannels = allGroupChannels;
        if (minAge !== null && minAge !== undefined) {
          const merchantMinAge = parseInt(minAge);
          if (!isNaN(merchantMinAge)) {
            eligibleChannels = allGroupChannels.filter(channel => {
              try {
                const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : (channel.config || {});
                const forceMinAge = config.params?.force_min_age;
                if (forceMinAge === null || forceMinAge === undefined || forceMinAge === '') {
                  return true;
                }
                const channelMinAge = parseInt(forceMinAge);
                return !isNaN(channelMinAge) && channelMinAge <= merchantMinAge;
              } catch (e) {
                return true;
              }
            });
            console.log(`轮询组minAge过滤: 商户要求${merchantMinAge}岁, 原${allGroupChannels.length}个通道, 过滤后${eligibleChannels.length}个`);
          }
        }
        
        if (eligibleChannels.length === 0) {
          // 轮询组中没有符合条件的通道，继续走下面的逻辑
        } else {
          // 重建 groupChannels，只保留符合条件的通道
          const eligibleIds = new Set(eligibleChannels.map(c => c.id));
          const filteredGroupChannels = groupChannels.filter(c => eligibleIds.has(c.id));
          
          // 根据轮询模式选择通道
          // mode: 0=顺序, 1=加权随机, 2=首个可用
          let selectedChannel;
          if (group.mode === 2) {
            // 首个可用
            selectedChannel = eligibleChannels.find(c => c.id === filteredGroupChannels[0]?.id) || eligibleChannels[0];
          } else if (group.mode === 1) {
            // 加权随机
            const totalWeight = filteredGroupChannels.reduce((sum, c) => sum + (c.weight || 1), 0);
            let random = Math.random() * totalWeight;
            let selectedId;
            for (const ch of filteredGroupChannels) {
              random -= (ch.weight || 1);
              if (random <= 0) {
                selectedId = ch.id;
                break;
              }
            }
            if (!selectedId) selectedId = filteredGroupChannels[0].id;
            selectedChannel = eligibleChannels.find(c => c.id === selectedId);
          } else {
            // 顺序轮询或默认随机
            const randomCh = filteredGroupChannels[Math.floor(Math.random() * filteredGroupChannels.length)];
            selectedChannel = eligibleChannels.find(c => c.id === randomCh.id);
          }
          
          if (selectedChannel) {
            logChannelSelectionInfo('轮询组选中通道', {
              payType,
              payGroupId: payGroup.id,
              payGroupName: payGroup.name,
              groupId: group.id,
              groupName: group.name,
              channelId: selectedChannel.id,
              channelName: selectedChannel.channel_name,
              plugin: selectedChannel.plugin_name
            });
            return selectedChannel;
          }
        }
      }
    }
    logChannelSelectionWarn('轮询组未选到通道，回退到支付方式通道池', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      groupId: typeConfig.group_id,
      reason: 'GROUP_EMPTY_OR_FILTERED'
    });
    // 轮询组无效或没有符合条件的通道，继续走下面的逻辑
  }
  
  // 查询该支付类型下的所有可用通道
  const [channels] = await db.query(
    `SELECT *, pay_type as type_code, channel_name as type_name
     FROM provider_channels 
     WHERE FIND_IN_SET(?, pay_type) AND status = 1
     ORDER BY id`,
    [payType]
  );
  
  if (channels.length === 0) {
    logChannelSelectionWarn('支付组选择失败：支付方式无可用通道', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      reason: 'NO_CHANNEL_FOR_PAY_TYPE'
    });
    return null;
  }
  
  // 如果商户传入了 minAge，过滤掉 force_min_age 限制更严格的通道
  // 规则：通道的 force_min_age 必须 <= 商户的 minAge（或通道未设置 force_min_age）
  let filteredChannels = channels;
  if (minAge !== null && minAge !== undefined) {
    const merchantMinAge = parseInt(minAge);
    if (!isNaN(merchantMinAge)) {
      filteredChannels = channels.filter(channel => {
        try {
          const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : (channel.config || {});
          const forceMinAge = config.params?.force_min_age;
          // 如果通道没有设置 force_min_age，则可用
          if (forceMinAge === null || forceMinAge === undefined || forceMinAge === '') {
            return true;
          }
          // 通道的 force_min_age 必须 <= 商户的 minAge
          const channelMinAge = parseInt(forceMinAge);
          return !isNaN(channelMinAge) && channelMinAge <= merchantMinAge;
        } catch (e) {
          return true; // 配置解析失败则认为通道可用
        }
      });
      console.log(`minAge过滤: 商户要求${merchantMinAge}岁, 原${channels.length}个通道, 过滤后${filteredChannels.length}个`);
    }
  }
  
  if (filteredChannels.length === 0) {
    logChannelSelectionWarn('支付组选择失败：通道被年龄限制过滤', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      minAge,
      reason: 'MIN_AGE_FILTERED_OUT'
    });
    return null;
  }
  
  // 如果只有一个通道，直接返回
  if (filteredChannels.length === 1) {
    logChannelSelectionInfo('支付组选中通道（唯一可用）', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      channelId: filteredChannels[0].id,
      channelName: filteredChannels[0].channel_name,
      plugin: filteredChannels[0].plugin_name
    });
    return filteredChannels[0];
  }
  
  if (mode > 0) {
    // 指定通道
    const specified = filteredChannels.find(c => c.id === mode);
    const selected = specified || filteredChannels[0];
    logChannelSelectionInfo('支付组选中通道（指定模式）', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      mode,
      requestedChannelId: mode,
      channelId: selected.id,
      channelName: selected.channel_name,
      plugin: selected.plugin_name,
      fallback: !specified
    });
    return selected;
  } else if (mode === -5) {
    // 首个可用
    const selected = filteredChannels[0];
    logChannelSelectionInfo('支付组选中通道（首个可用）', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      mode,
      channelId: selected.id,
      channelName: selected.channel_name,
      plugin: selected.plugin_name
    });
    return selected;
  } else if (mode === -4) {
    // 顺序轮询 - TODO: 需要实现索引记录
    const randomIndex = Math.floor(Math.random() * filteredChannels.length);
    const selected = filteredChannels[randomIndex];
    logChannelSelectionInfo('支付组选中通道（顺序轮询-当前实现随机）', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      mode,
      channelId: selected.id,
      channelName: selected.channel_name,
      plugin: selected.plugin_name
    });
    return selected;
  } else {
    // 默认随机
    const randomIndex = Math.floor(Math.random() * filteredChannels.length);
    const selected = filteredChannels[randomIndex];
    logChannelSelectionInfo('支付组选中通道（随机）', {
      payType,
      payGroupId: payGroup.id,
      payGroupName: payGroup.name,
      mode,
      channelId: selected.id,
      channelName: selected.channel_name,
      plugin: selected.plugin_name
    });
    return selected;
  }
}

// 执行支付
router.post('/dopay', async (req, res) => {
  try {
    const { trade_no, pay_type, group_id } = req.body;

    if (!trade_no) {
      return res.json({ code: 1, msg: '订单号不能为空' });
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 状态: 0=待支付 1=已支付 2=已关闭'
    if (order.status !== 0) {
      return res.json({ code: 1, msg: '订单状态异常' });
    }

    const snapshotGroupId = getOrderPayGroupSnapshot(order);
    let effectiveGroupId = group_id;
    if (order.order_type === 'test') {
      const testRuntime = await getTestPaymentRuntimeConfig();
      if (!testRuntime.payGroupId) {
        return res.json({ code: 1, msg: '测试支付未配置支付组' });
      }
      effectiveGroupId = testRuntime.payGroupId;
    } else if (snapshotGroupId) {
      // 新订单以创建时快照为准，不信任前端传入组ID
      effectiveGroupId = snapshotGroupId;
    }

    let channelConfig;
    let finalPayType;
    let isLockedChannelOrder = false;
    
    // ========== 检查订单是否已锁定通道 ==========
    if (order.channel_id) {
      isLockedChannelOrder = true;
      // 订单已选择过通道，使用之前的通道，不允许更改
      const [channels] = await db.query(
        `SELECT *, pay_type as type_code, channel_name as type_name
         FROM provider_channels WHERE id = ?`,
        [order.channel_id]
      );

      if (channels.length === 0) {
        return res.json({ code: 1, msg: '支付通道已失效，请联系客服' });
      }
      
      channelConfig = channels[0];
      finalPayType = order.pay_type || pay_type;
      if (pay_type && order.pay_type && pay_type !== order.pay_type) {
        logChannelSelectionInfo('DoPay 锁定订单忽略外部 pay_type', {
          tradeNo: order.trade_no,
          orderId: order.id,
          requestedPayType: pay_type,
          lockedPayType: order.pay_type,
          channelId: channelConfig.id,
          channelName: channelConfig.channel_name,
          plugin: channelConfig.plugin_name
        });
      }
      if (!finalPayType) {
        return res.json({ code: 1, msg: '订单缺少已锁定支付方式，请联系客服处理' });
      }
      logChannelSelectionInfo('订单已锁定通道', {
        tradeNo: order.trade_no,
        orderId: order.id,
        payType: finalPayType,
        payGroupId: effectiveGroupId || null,
        channelId: channelConfig.id,
        channelName: channelConfig.channel_name,
        plugin: channelConfig.plugin_name
      });
    } else {
      // ========== 订单未选择通道，进行通道选择 ==========
      // 使用传入的 pay_type 或订单已选择的 pay_type
      finalPayType = pay_type || order.pay_type;
      
      if (!finalPayType) {
        return res.json({ code: 1, msg: '未选择支付方式' });
      }

      // 解析商户传入的 min_age 用于通道筛选
      let merchantMinAge = null;
      if (order.cert_info) {
        try {
          const certInfo = typeof order.cert_info === 'string' 
            ? JSON.parse(order.cert_info) 
            : order.cert_info;
          if (certInfo.min_age) {
            merchantMinAge = parseInt(certInfo.min_age);
          }
        } catch (e) {
          console.error('解析 cert_info 失败:', e);
        }
      }

      // 根据支付组选择通道（测试订单强制使用测试支付组）
      channelConfig = await selectChannelFromGroup(finalPayType, effectiveGroupId, { minAge: merchantMinAge });

      if (!channelConfig) {
        logChannelSelectionWarn('DoPay 选通道失败', {
          tradeNo: order.trade_no,
          orderId: order.id,
          payType: finalPayType,
          payGroupId: effectiveGroupId || null,
          minAge: merchantMinAge,
          reason: merchantMinAge ? 'NO_CHANNEL_MATCH_MIN_AGE' : 'NO_AVAILABLE_CHANNEL'
        });
        return res.json({ code: 1, msg: merchantMinAge ? '没有符合年龄限制的支付通道可用' : '支付通道不可用，请联系服务商' });
      }

      logChannelSelectionInfo('DoPay 选中通道', {
        tradeNo: order.trade_no,
        orderId: order.id,
        payType: finalPayType,
        payGroupId: effectiveGroupId || null,
        minAge: merchantMinAge,
        channelId: channelConfig.id,
        channelName: channelConfig.channel_name,
        plugin: channelConfig.plugin_name
      });

      // 获取商户信息计算费率
      const [merchants] = await db.query(
        'SELECT fee_rate as merchant_fee_rate, fee_payer, pay_group_id FROM merchants WHERE user_id = ?',
        [order.merchant_id]
      );
      const merchant = merchants[0]
        ? {
            ...merchants[0],
            pay_group_id: order.order_type === 'test' ? effectiveGroupId : merchants[0].pay_group_id
          }
        : (order.order_type === 'test' ? { pay_group_id: effectiveGroupId } : {});
      
      // 获取费率：商户个人费率优先，否则用支付组费率
      const feeRate = await getMerchantFeeRate(merchant, finalPayType);
      const feePayer = merchant.fee_payer || 'merchant';
      
      // 计算手续费
      const moneyFloat = parseFloat(order.money);
      const feeMoney = feeRate ? parseFloat((moneyFloat * feeRate).toFixed(2)) : 0;
      const realMoney = feePayer === 'buyer' ? parseFloat((moneyFloat + feeMoney).toFixed(2)) : moneyFloat;
      
      console.log('DoPay费率计算:', {
        pay_type: finalPayType,
        channel_id: channelConfig.id,
        plugin_name: channelConfig.plugin_name,
        merchant_fee_rate: merchant.merchant_fee_rate,
        final_feeRate: feeRate,
        feeMoney,
        realMoney,
        feePayer
      });

      // 更新订单通道、支付类型、手续费和插件名（锁定通道）
      await db.query(
        'UPDATE orders SET channel_id = ?, pay_type = ?, plugin_name = ?, fee_money = ?, real_money = ?, fee_payer = ? WHERE id = ?',
        [channelConfig.id, finalPayType, channelConfig.plugin_name, feeMoney, realMoney, feePayer, order.id]
      );
      
      // 更新 order 对象以便后续使用
      order.real_money = realMoney;
      order.channel_id = channelConfig.id;
    }

    const getReusableDoPayPayload = () => {
      if (!isLockedChannelOrder) {
        return null;
      }
      const orderParam = parseOrderParam(order.param);
      const cached = orderParam && orderParam.dopay_cache ? orderParam.dopay_cache : null;
      if (!cached || typeof cached !== 'object') {
        return null;
      }
      if (String(cached.channel_id || '') !== String(channelConfig.id || '')) {
        return null;
      }
      if (String(cached.pay_type || '') !== String(finalPayType || '')) {
        return null;
      }
      if (!cached.payload || typeof cached.payload !== 'object') {
        return null;
      }
      if (cached.payload.code !== 0) {
        return null;
      }
      return cached.payload;
    };

    const persistDoPayPayload = async (payload) => {
      if (!payload || payload.code !== 0) {
        return;
      }
      try {
        const orderParam = parseOrderParam(order.param);
        orderParam.dopay_cache = {
          channel_id: channelConfig.id,
          pay_type: finalPayType,
          plugin_name: channelConfig.plugin_name,
          updated_at: Math.floor(Date.now() / 1000),
          payload
        };
        const paramRaw = JSON.stringify(orderParam);
        await db.query('UPDATE orders SET param = ? WHERE id = ?', [paramRaw, order.id]);
        order.param = paramRaw;
      } catch (cacheError) {
        console.warn('[DoPayCache] 保存支付拉起结果失败', {
          tradeNo: order.trade_no,
          orderId: order.id,
          channelId: channelConfig && channelConfig.id,
          payType: finalPayType,
          error: cacheError.message
        });
      }
    };

    const sendSuccess = async (payload) => {
      await persistDoPayPayload(payload);
      return res.json(payload);
    };

    const cachedPayload = getReusableDoPayPayload();
    if (cachedPayload) {
      logChannelSelectionInfo('DoPay 复用已锁定订单支付结果', {
        tradeNo: order.trade_no,
        orderId: order.id,
        payType: finalPayType,
        channelId: channelConfig.id,
        channelName: channelConfig.channel_name,
        plugin: channelConfig.plugin_name
      });
      return res.json(cachedPayload);
    }

    // 获取插件
    const plugin = pluginLoader.getPlugin(channelConfig.plugin_name);
    if (!plugin) {
      return res.json({ code: 1, msg: `支付插件 ${channelConfig.plugin_name} 不存在` });
    }

    // 解析通道配置
    let pluginConfig = {};
    let channelConfigJson = {};
    try {
      channelConfigJson = typeof channelConfig.config === 'string' 
        ? JSON.parse(channelConfig.config) 
        : (channelConfig.config || {});
      
      // 构建插件配置，与 PHP 版本的 $channel 变量格式对齐
      pluginConfig = {
        // 通道基本信息
        id: channelConfig.id,
        name: channelConfig.channel_name,
        plugin: channelConfig.plugin_name,
        // 展开参数配置 (appid, appkey, appsecret, appmchid 等）
        ...channelConfigJson.params,
        // apptype - 支付接口选择，数组格式 ['1', '2', '3']
        apptype: channelConfigJson.apptype || [],
        // 证书配置
        config: {
          certs: channelConfigJson.certs || {}
        },
        // 绑定的微信公众号配置 (用于 JSAPI 支付获取 openid)
        wxmp: channelConfigJson.wxmp || null,
        // 绑定的微信小程序配置 (用于小程序跳转支付)
        wxa: channelConfigJson.wxa || null
      };
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 获取基础URL（使用请求的域名）
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    
    // 获取实际支付金额（已锁定订单使用数据库中的值）
    const realMoney = parseFloat(order.real_money || order.money) || 0;
    
    // 获取订单名称模板配置，支持自定义商品名称
    const orderNameTemplate = await systemConfig.getConfig('order_name_template', '');
    let displayName = order.name;
    if (orderNameTemplate) {
      displayName = systemConfig.replaceOrderName(orderNameTemplate, {
        name: order.name,
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        merchant_id: order.merchant_id
      });
    }

    // 设备检测
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const is_mobile = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
    const is_wechat = userAgent.includes('micromessenger');
    const is_alipay = userAgent.includes('alipay');
    const is_qq = userAgent.includes('qq/');
    
    // 构建订单信息给插件
    const orderInfo = {
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      money: realMoney,
      name: displayName,  // 使用处理后的商品名称
      original_name: order.name,  // 保留原始名称
      pay_type: finalPayType,
      notify_url: `${baseUrl}/api/pay/notify/${order.trade_no}`,
      return_url: `${baseUrl}/api/pay/return/${order.trade_no}`,
      client_ip: order.client_ip || '127.0.0.1',
      clientip: order.client_ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || '',
      // 设备检测信息
      is_mobile,
      is_wechat,
      is_alipay,
      is_qq,
      device: is_mobile ? 'mobile' : 'pc',
      mdevice: is_wechat ? 'wechat' : (is_alipay ? 'alipay' : (is_qq ? 'qq' : ''))
    };
    
    // 解析买家身份限制信息并添加到 orderInfo
    if (order.cert_info) {
      try {
        const certInfo = typeof order.cert_info === 'string' 
          ? JSON.parse(order.cert_info) 
          : order.cert_info;
        if (certInfo.cert_no) orderInfo.cert_no = certInfo.cert_no;
        if (certInfo.cert_name) orderInfo.cert_name = certInfo.cert_name;
        if (certInfo.min_age) orderInfo.min_age = certInfo.min_age;
      } catch (e) {
        console.error('解析 cert_info 失败:', e);
      }
    }

    console.log('调用支付插件:', channelConfig.plugin_name, orderInfo);

    // 调用插件发起支付
    let result;
    if (typeof plugin[finalPayType] === 'function') {
      // 如果插件有对应支付类型的方法，调用之（如 alipay, wxpay 等）
      result = await plugin[finalPayType](pluginConfig, orderInfo);
    } else if (typeof plugin.submit === 'function') {
      // 否则调用通用 submit 方法
      result = await plugin.submit(pluginConfig, orderInfo);
    } else {
      return res.json({ code: 1, msg: '支付插件不支持该支付方式' });
    }

    console.log('支付插件返回:', result);

    // 处理插件返回结果
    if (result.type === 'error') {
      // 检查是否需要自动关闭通道
      await checkAndAutoCloseChannel(result.msg, channelConfig);
      logChannelSelectionError('DoPay 插件返回错误', {
        tradeNo: order.trade_no,
        orderId: order.id,
        payType: finalPayType,
        channelId: channelConfig?.id,
        channelName: channelConfig?.channel_name,
        plugin: channelConfig?.plugin_name,
        error: result.msg || 'UNKNOWN_PLUGIN_ERROR'
      });
      return res.json({ code: 1, msg: result.msg || '支付失败' });
    }

    if (result.type === 'jump') {
      const jumpUrl = String(result.url || '');
      const lowerJumpUrl = jumpUrl.toLowerCase();
      const isQrcodeImageUrl = /^https?:\/\//.test(lowerJumpUrl)
        && (
          lowerJumpUrl.includes('qr.alipay.com')
          || lowerJumpUrl.includes('/qrcode')
          || /\.(png|jpg|jpeg|gif|webp)(\?|$)/.test(lowerJumpUrl)
        );

      if (isQrcodeImageUrl) {
        return sendSuccess({ code: 0, msg: 'success', qrcode: jumpUrl, expire_time: order.expire_at || null });
      }

      // 检查是否是跳转到 qrcode 页面，如果是则直接获取二维码返回
      const qrcodeMatch = result.url.match(/^\/pay\/qrcode(?:pc)?\/([^\/\?]+)/);
      if (qrcodeMatch && typeof plugin.qrcode === 'function') {
        try {
          // 调用插件的 qrcode 方法获取二维码
          const conf = {
            siteurl: baseUrl + '/',
            localurl: baseUrl + '/',
            http_host: req.get('host')
          };
          const qrcodeResult = await plugin.qrcode(pluginConfig, orderInfo, conf);
          
          if (qrcodeResult.type === 'qrcode') {
            return sendSuccess({ code: 0, msg: 'success', qrcode: qrcodeResult.url, expire_time: order.expire_at || null });
          } else if (qrcodeResult.type === 'jump') {
            // 如果 qrcode 方法也返回跳转（如支付宝内打开），则返回跳转
            return sendSuccess({ code: 0, msg: 'success', pay_url: qrcodeResult.url });
          } else if (qrcodeResult.type === 'error') {
            return res.json({ code: 1, msg: qrcodeResult.msg || '获取二维码失败' });
          }
        } catch (e) {
          console.error('获取二维码失败:', e);
          // 如果获取二维码失败，降级为跳转
        }
      }
      return sendSuccess({ code: 0, msg: 'success', pay_url: result.url });
    }

    if (result.type === 'qrcode') {
      return sendSuccess({ code: 0, msg: 'success', qrcode: result.qr_code || result.url, expire_time: order.expire_at || null });
    }

    if (result.type === 'html') {
      return sendSuccess({ code: 0, msg: 'success', html: result.data });
    }

    if (result.type === 'scheme') {
      return sendSuccess({ code: 0, msg: 'success', scheme: result.url });
    }

    if (result.type === 'page') {
      // 渲染页面类型 - 根据页面类型返回不同数据
      if (result.page === 'alipay_h5') {
        // 支付宝H5唤起APP - 返回数据让前端在页面内显示
        return sendSuccess({ 
          code: 0, 
          msg: 'success', 
          alipay_h5: {
            code_url: result.data.code_url,
            redirect_url: result.data.redirect_url,
            money: orderInfo.money
          }
        });
      }
      // 其他页面类型 - 跳转到渲染路由
      return sendSuccess({ 
        code: 0, 
        msg: 'success', 
        pay_url: `/pay/render/${orderInfo.trade_no}/${result.page}` 
      });
    }

    if (result.type === 'app') {
      // APP SDK调用字符串 - 返回给APP使用
      return sendSuccess({ code: 0, msg: 'success', app_data: result.data });
    }

    // 默认返回跳转URL
    return sendSuccess({ code: 0, msg: 'success', pay_url: result.url || result.pay_url });

  } catch (error) {
    console.error('DoPay Error:', {
      message: error.message,
      stack: error.stack
    });
    logChannelSelectionError('DoPay 处理异常', {
      error: error.message
    });
    // 注意：此处 channelConfig 可能未定义，需要安全访问
    if (typeof channelConfig !== 'undefined' && channelConfig) {
      await checkAndAutoCloseChannel(error.message, channelConfig);
    }
    res.json({ code: 1, msg: error.message || '系统错误' });
  }
});

// 渲染支付页面（用于APP支付、预授权等需要特定页面的支付方式）
router.get('/render/:trade_no/:page', async (req, res) => {
  try {
    const { trade_no, page } = req.params;

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在' });
    }

    const order = orders[0];

    // 获取通道配置
    if (!order.channel_id) {
      return res.render('error', { message: '订单无支付通道' });
    }

    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      return res.render('error', { message: '支付通道不存在' });
    }

    const channel = channels[0];
    const pluginName = channel.plugin_name || order.plugin_name;

    // 获取插件配置
    let pluginConfig = {};
    try {
      const channelConfig = typeof channel.config === 'string' 
        ? JSON.parse(channel.config) 
        : (channel.config || {});
      pluginConfig = channelConfig.params || {};
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 重新调用插件获取页面数据
    const plugin = pluginLoader.getPlugin(pluginName);
    if (!plugin) {
      return res.render('error', { message: '支付插件不存在' });
    }

    // 构造订单信息
    const orderInfo = {
      trade_no: order.trade_no,
      money: parseFloat(order.real_money || order.money),
      name: order.name || '订单支付',
      notify_url: `${req.protocol}://${req.get('host')}/api/pay/notify/${trade_no}`,
      return_url: `${req.protocol}://${req.get('host')}/api/pay/return/${trade_no}`,
      clientip: getClientIP(req)
    };

    // 根据页面类型渲染
    if (page === 'alipay_h5') {
      // 支付宝H5唤起APP页面
      // 重新调用插件获取SDK数据
      const payType = order.pay_type || 'apppay';
      if (typeof plugin[payType] === 'function') {
        const result = await plugin[payType](pluginConfig, orderInfo);
        if (result.type === 'page' && result.data) {
          return res.render('alipay_h5', {
            code_url: result.data.code_url,
            redirect_url: result.data.redirect_url,
            order,
            trade_no
          });
        }
      }
    }

    // 默认渲染错误页
    return res.render('error', { message: '不支持的页面类型' });

  } catch (error) {
    console.error('Render Page Error:', error);
    res.render('error', { message: error.message || '系统错误' });
  }
});

// 异步通知（上游支付通道回调） 按订单号
router.all('/notify/:trade_no', async (req, res) => {
  try {
    const { trade_no } = req.params;
    const params = { ...req.query, ...req.body };

    console.log('支付回调通知, trade_no:', trade_no);
    console.log('回调 method:', req.method);
    console.log('回调 content-type:', req.get('content-type'));
    console.log('回调 query:', req.query);
    console.log('回调 body:', req.body);
    console.log('回调 params合并:', params);

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      console.log('订单不存在 ', trade_no);
      return res.send('fail');
    }

    const order = orders[0];

    // 获取通道配置
    if (!order.channel_id) {
      console.log('订单无通道ID:', trade_no);
      return res.send('fail');
    }

    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      console.log('通道不存在', order.channel_id);
      return res.send('fail');
    }

    const channel = channels[0];
    const pluginName = channel.plugin_name || order.plugin_name;

    // 获取插件
    const plugin = pluginLoader.getPlugin(pluginName);
    if (!plugin || typeof plugin.notify !== 'function') {
      console.log('插件不存在或不支持回调', pluginName);
      return res.send('fail');
    }

    // 解析通道配置
    let pluginConfig = {};
    try {
      const channelConfig = typeof channel.config === 'string' 
        ? JSON.parse(channel.config) 
        : (channel.config || {});
      pluginConfig = channelConfig.params || {};
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 调用插件验证回调
    const notifyResult = await plugin.notify(pluginConfig, params, order);
    console.log('插件回调验证结果:', notifyResult);

    if (notifyResult.success) {
      // 订单状态为待支付时才处理
      if (order.status === 0) {
        // 更新订单状态
        await db.query(
          `UPDATE orders SET status = 1, paid_at = NOW(), api_trade_no = ?, buyer = ? WHERE id = ?`,
          [notifyResult.api_trade_no || null, notifyResult.buyer || null, order.id]
        );

        // 重新查询订单
        const [updatedOrders] = await db.query('SELECT * FROM orders WHERE id = ?', [order.id]);
        const updatedOrder = updatedOrders[0];

        // 发送下游通知给商户
        await sendDownstreamNotify(updatedOrder);
      }

      // 返回成功响应
      if (plugin.getNotifyResponse) {
        return res.send(plugin.getNotifyResponse(true));
      }
      return res.send('success');
    } else {
      console.log('回调验证失败');
      if (plugin.getNotifyResponse) {
        return res.send(plugin.getNotifyResponse(false));
      }
      return res.send('fail');
    }

  } catch (error) {
    console.error('Notify Error:', error);
    res.send('fail');
  }
});

// 同步跳转（支付完成后跳转） 按订单号
router.all('/return/:trade_no', async (req, res) => {
  try {
    const { trade_no } = req.params;
    const params = { ...req.query, ...req.body };

    console.log('支付同步回调, trade_no:', trade_no);

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在', code: 'ORDER_NOT_FOUND', backUrl: null });
    }

    const order = orders[0];
    let effectiveOrder = order;

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const loadLatestOrderById = async (orderId) => {
      const [rows] = await db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId]);
      return rows.length > 0 ? rows[0] : null;
    };
    const confirmPaidWithDelay = async (reason) => {
      let latest = await loadLatestOrderById(order.id);
      if (latest && Number(latest.status) === 1) {
        console.warn('[ReturnFallback] 即时查询确认订单已支付，放行跳转', {
          tradeNo: order.trade_no,
          orderId: order.id,
          reason
        });
        return latest;
      }

      await wait(1000);
      latest = await loadLatestOrderById(order.id);
      if (latest && Number(latest.status) === 1) {
        console.warn('[ReturnFallback] 延迟1秒查询确认订单已支付，放行跳转', {
          tradeNo: order.trade_no,
          orderId: order.id,
          reason
        });
        return latest;
      }

      return null;
    };

    // 获取通道配置
    if (order.channel_id) {
      const [channels] = await db.query(
        'SELECT * FROM provider_channels WHERE id = ?',
        [order.channel_id]
      );

      if (channels.length > 0) {
        const channel = channels[0];
        const pluginName = channel.plugin_name || order.plugin_name;
        const plugin = pluginLoader.getPlugin(pluginName);

        if (plugin && typeof plugin.returnCallback === 'function') {
          let pluginConfig = {};
          try {
            const channelConfig = typeof channel.config === 'string' 
              ? JSON.parse(channel.config) 
              : (channel.config || {});
            pluginConfig = channelConfig.params || {};
          } catch (e) {}

          let returnResult;
          try {
            returnResult = await plugin.returnCallback(pluginConfig, params, order);
          } catch (pluginError) {
            const paidOrder = await confirmPaidWithDelay(`RETURN_CALLBACK_ERROR:${pluginError.message || 'unknown'}`);
            if (paidOrder) {
              effectiveOrder = paidOrder;
              returnResult = { success: false, msg: pluginError.message || 'return callback exception' };
            } else {
              return res.render('error', {
                message: '还没收到支付成功数据，请稍后重试',
                code: 'PAYMENT_PENDING_CONFIRM',
                backUrl: req.originalUrl
              });
            }
          }

          if (returnResult.success) {
            // 更新订单（如果还未支付）
            if (order.status === 0) {
              await db.query(
                `UPDATE orders SET status = 1, paid_at = NOW(), api_trade_no = ?, buyer = ? WHERE id = ?`,
                [returnResult.api_trade_no || null, returnResult.buyer || null, order.id]
              );
              // 发送下游通知
              const [updatedOrders] = await db.query('SELECT * FROM orders WHERE id = ?', [order.id]);
              if (updatedOrders.length > 0) {
                effectiveOrder = updatedOrders[0];
                await sendDownstreamNotify(effectiveOrder);
              }
            }
          } else if (returnResult.msg) {
            const paidOrder = await confirmPaidWithDelay(`VERIFY_FAILED:${returnResult.msg}`);
            if (paidOrder) {
              effectiveOrder = paidOrder;
            } else {
              return res.render('error', {
                message: '还没收到支付成功数据，请稍后重试',
                code: 'PAYMENT_PENDING_CONFIRM',
                backUrl: req.originalUrl
              });
            }
          }
        }
      }
    }

    // 跳转到商户回调地址或成功页面
    if (effectiveOrder.return_url) {
      // 构建带参数的回调URL
      const [merchants] = await db.query(
        'SELECT api_key, pid FROM merchants WHERE user_id = ?',
        [effectiveOrder.merchant_id]
      );
      
      if (merchants.length > 0) {
        const callbackParams = buildCallbackParams(effectiveOrder, merchants[0].api_key, merchants[0].pid);
        const returnUrl = new URL(effectiveOrder.return_url);
        Object.entries(callbackParams).forEach(([k, v]) => {
          returnUrl.searchParams.set(k, v);
        });
        return res.redirect(returnUrl.toString());
      }
      return res.redirect(effectiveOrder.return_url);
    }

    // 无回调地址，显示成功页面
    res.render('success', { order: effectiveOrder });

  } catch (error) {
    console.error('Return Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

function generateRefundNo() {
  return 'R' + Date.now() + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function markTestAutoRefundFailed(orderId, reason) {
  const safeReason = String(reason || '自动退款失败')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);

  if (!orderId || !safeReason) {
    return;
  }

  try {
    await db.query(
      `UPDATE orders
       SET refund_status = 2, refund_reason = ?
       WHERE id = ? AND status = 1 AND (refund_status IS NULL OR refund_status <> 1)`,
      [safeReason, orderId]
    );
  } catch (error) {
    console.error(`记录测试订单自动退款失败原因异常: order_id=${orderId}`, error);
  }
}

// 测试订单支付成功后自动秒退（可配置）
async function tryAutoRefundTestOrder(order) {
  if (!order || order.order_type !== 'test') {
    return;
  }

  const testRuntime = await getTestPaymentRuntimeConfig();
  if (!testRuntime.enabled || !testRuntime.autoRefund) {
    return;
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `SELECT id, trade_no, out_trade_no, merchant_id, channel_id, plugin_name, pay_type, name,
              money, real_money, fee_money, status, refund_status, refund_money, balance_added, api_trade_no
       FROM orders WHERE id = ? FOR UPDATE`,
      [order.id]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return;
    }

    const lockedOrder = rows[0];
    const refundedMoney = parseFloat(lockedOrder.refund_money || 0);
    const refundStatus = parseInt(lockedOrder.refund_status || 0, 10);

    // 仅待退款的已支付测试订单执行秒退，避免重复退款
    if (lockedOrder.status !== 1 || refundStatus === 1 || refundedMoney > 0) {
      await connection.rollback();
      return;
    }

    if (!lockedOrder.api_trade_no || !lockedOrder.channel_id) {
      await connection.rollback();
      await markTestAutoRefundFailed(lockedOrder.id, '自动退款失败：缺少上游交易号或通道');
      console.warn(`测试订单自动退款跳过: 缺少上游交易号或通道, trade_no=${lockedOrder.trade_no}`);
      return;
    }

    const [channels] = await connection.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [lockedOrder.channel_id]
    );

    if (channels.length === 0) {
      await connection.rollback();
      await markTestAutoRefundFailed(lockedOrder.id, '自动退款失败：支付通道不存在');
      console.warn(`测试订单自动退款跳过: 通道不存在, trade_no=${lockedOrder.trade_no}`);
      return;
    }

    const channel = channels[0];
    const plugin = pluginLoader.getPlugin(channel.plugin_name || lockedOrder.plugin_name);
    if (!plugin || typeof plugin.refund !== 'function') {
      await connection.rollback();
      await markTestAutoRefundFailed(lockedOrder.id, '自动退款失败：当前通道不支持退款');
      console.warn(`测试订单自动退款跳过: 通道不支持退款, trade_no=${lockedOrder.trade_no}`);
      return;
    }

    let channelConfigJson;
    try {
      channelConfigJson = channel.config ? JSON.parse(channel.config) : {};
    } catch (e) {
      channelConfigJson = {};
    }

    const channelParams = (channelConfigJson && typeof channelConfigJson === 'object')
      ? (channelConfigJson.params || {})
      : {};

    const fullConfig = {
      ...channelParams,
      appurl: channelParams.appurl || '',
      appid: channelParams.appid || channel.app_id,
      appmchid: channelParams.appmchid || channel.app_mch_id,
      appkey: channelParams.appkey || channel.app_key,
      appsecret: channelParams.appsecret || channel.app_secret,
      config: {
        certs: channelConfigJson.certs || {}
      }
    };

    const totalMoney = parseFloat(lockedOrder.real_money || lockedOrder.money || 0);
    if (!(totalMoney > 0)) {
      await connection.rollback();
      await markTestAutoRefundFailed(lockedOrder.id, '自动退款失败：退款金额无效');
      console.warn(`测试订单自动退款跳过: 金额无效, trade_no=${lockedOrder.trade_no}`);
      return;
    }

    const refundNo = generateRefundNo();
    const refundResult = await plugin.refund(fullConfig, {
      trade_no: lockedOrder.trade_no,
      api_trade_no: lockedOrder.api_trade_no,
      refund_no: refundNo,
      refund_money: totalMoney,
      total_money: totalMoney
    });

    if (!refundResult || refundResult.code !== 0) {
      await connection.rollback();
      const refundMsg = refundResult && refundResult.msg ? refundResult.msg : '未知错误';
      await markTestAutoRefundFailed(lockedOrder.id, `自动退款失败：${refundMsg}`);
      console.warn(`测试订单自动退款失败: trade_no=${lockedOrder.trade_no}, msg=${refundMsg}`);
      return;
    }

    // 若此前已给商户加款，则秒退时等额扣回商户实收金额
    if (lockedOrder.balance_added) {
      const orderMoney = parseFloat(lockedOrder.money || 0);
      const feeMoney = parseFloat(lockedOrder.fee_money || 0);
      const reduceMoney = Math.round((orderMoney - feeMoney) * 100) / 100;
      if (reduceMoney > 0) {
        await connection.query(
          'UPDATE merchants SET balance = balance - ? WHERE user_id = ?',
          [reduceMoney, lockedOrder.merchant_id]
        );
      }
    }

    await connection.query(
      'UPDATE orders SET status = 2, refund_status = 1, refund_no = ?, refund_money = ?, refund_reason = ?, refund_at = NOW() WHERE id = ?',
      [refundNo, totalMoney, '测试支付自动秒退', lockedOrder.id]
    );

    await connection.commit();
    console.log(`测试订单自动退款成功: trade_no=${lockedOrder.trade_no}, refund_no=${refundNo}`);
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {}
    await markTestAutoRefundFailed(order.id, `自动退款异常：${error.message || '系统异常'}`);
    console.error('测试订单自动退款异常:', error);
  } finally {
    connection.release();
  }
}

function scheduleAutoRefundTestOrder(order, delayMs = 30000) {
  if (!order || order.order_type !== 'test') {
    return;
  }

  setTimeout(() => {
    tryAutoRefundTestOrder(order).catch((error) => {
      console.error('测试订单延迟自动退款异常:', error);
    });
  }, delayMs);
}

// 发送下游通知给商户，并增加商户余额
async function sendDownstreamNotify(order) {
  try {
    // 获取商户密钥
    const [merchants] = await db.query(
      'SELECT api_key, pid FROM merchants WHERE user_id = ?',
      [order.merchant_id]
    );
    const merchant = merchants[0] || null;

    if (merchant) {
      // 增加商户余额（订单金额 - 手续费）
      // 使用事务保护避免重复增加和数据不一致
      const settleAmount = parseFloat(order.money) - parseFloat(order.fee_money || 0);
      let balanceIncreased = false;
      let balanceAfterIncrease = null;
      if (settleAmount > 0) {
        const connection = await db.getConnection();
        try {
          await connection.beginTransaction();

          const [orderCheck] = await connection.query(
            'SELECT balance_added FROM orders WHERE id = ? FOR UPDATE',
            [order.id]
          );

          if (orderCheck.length > 0 && !orderCheck[0].balance_added) {
            await connection.query(
              'UPDATE merchants SET balance = balance + ? WHERE user_id = ?',
              [settleAmount, order.merchant_id]
            );
            await connection.query('UPDATE orders SET balance_added = 1 WHERE id = ?', [order.id]);
            const [merchantBalanceRows] = await connection.query(
              'SELECT balance FROM merchants WHERE user_id = ? LIMIT 1',
              [order.merchant_id]
            );
            balanceAfterIncrease = parseFloat(merchantBalanceRows[0]?.balance || 0);
            balanceIncreased = true;
            console.log(`商户余额增加: user_id=${order.merchant_id}, amount=${settleAmount}`);
          }

          await connection.commit();
        } catch (txError) {
          await connection.rollback();
          console.error('余额增加事务失败:', txError);
        } finally {
          connection.release();
        }
      }

      if (balanceIncreased) {
        try {
          await telegramService.notifyBalance(order.merchant_id, 'merchant', {
            type: 'income',
            amount: settleAmount,
            balance: balanceAfterIncrease,
            reason: `订单收款入账: ${order.trade_no}`
          });
        } catch (balanceNotifyError) {
          console.error('发送余额变动通知失败:', balanceNotifyError);
        }
      }

      // 实时自动结算：仅在本次确实增加了余额后触发
      if (balanceIncreased) {
        try {
          await autoSettlementService.triggerRealtime(order.merchant_id);
        } catch (autoSettleError) {
          console.error('实时自动结算触发失败:', autoSettleError);
        }
      }

      let paymentNotifyStatus = order.notify_url ? 1 : 2;

      if (order.notify_url) {
        const notifyOrderName = await systemConfig.getConfig('notify_order_name', '0');
        let orderForNotify = order;
        if (notifyOrderName === '1') {
          orderForNotify = { ...order, name: 'product' };
        }

        const notifyParams = buildCallbackParams(orderForNotify, merchant.api_key, merchant.pid);
        console.log('发送商户通知:', order.notify_url, notifyParams);

        const success = await sendNotify(order.notify_url, notifyParams);
        paymentNotifyStatus = success ? 2 : 1;
        console.log('商户通知结果:', success ? '成功' : '失败');

        await db.query(
          'UPDATE orders SET notify_status = ?, notify_count = notify_count + 1, notify_time = NOW() WHERE id = ?',
          [success ? 1 : 2, order.id]
        );
      }

      // 发送 Telegram 通知给用户（订单交易通知）
      try {
        telegramService.notifyPayment({
          trade_no: order.trade_no,
          out_trade_no: order.out_trade_no,
          money: order.money,
          real_money: order.real_money || order.money,
          type: order.pay_type,
          name: order.name,
          status: paymentNotifyStatus,
          merchant_id: order.merchant_id,
          pid: merchant.pid
        });
      } catch (tgError) {
        console.error('发送 Telegram 用户通知失败:', tgError);
      }
    }

    // 测试订单可配置自动退款，延迟30秒执行，降低上游刚支付即退款的失败概率
    scheduleAutoRefundTestOrder(order, 30000);
  } catch (error) {
    console.error('处理支付后续逻辑失败:', error);
  }
}

// 二维码支付页面
router.get('/qrcode', async (req, res) => {
  try {
    const { trade_no, url } = req.query;

    if (!trade_no || !url) {
      return res.render('error', { message: '参数错误', code: 'PARAM_ERROR', backUrl: null });
    }

    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在', code: 'ORDER_NOT_FOUND', backUrl: null });
    }

    const order = orders[0];

    // 如果订单已支付，跳转到成功页面
    if (order.status === 1) {
      return res.redirect(`/api/pay/success?trade_no=${trade_no}`);
    }

    // 重定向到收银台页面，透传 pay_type 以便直连模式生效
    const payTypeQuery = order.pay_type ? `&pay_type=${encodeURIComponent(order.pay_type)}` : '';
    res.redirect(`/api/pay/cashier?trade_no=${trade_no}${payTypeQuery}`);

  } catch (error) {
    console.error('QRCode Page Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

// 检查订单状态（供二维码页面轮询组）
router.get('/check_status', async (req, res) => {
  try {
    const { trade_no, visitor_id, visitor_sig } = req.query;

    if (!trade_no) {
      return res.json({ code: 1, msg: '订单号不能为空' });
    }

    const [orders] = await db.query(
      'SELECT trade_no, status, refund_status, refund_reason, order_type, param FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];
    const accessResult = verifyTestOrderVisitorAccess(order, visitor_id, visitor_sig);
    if (!accessResult.ok) {
      return res.status(403).json({ code: 1, msg: '无权查询该订单状态' });
    }

    const refundStatus = parseInt(order.refund_status || 0, 10);
    const refunded = order.status === 2 && refundStatus === 1;
    const refundFailed = refundStatus === 2;
    // status: 0=待支付 1=已支付 2=已关闭/退款'
    res.json({ 
      code: 0, 
      status: order.status,
      refund_status: refundStatus,
      refund_reason: order.refund_reason || '',
      paid: order.status === 1 || refunded,
      refunded,
      refund_failed: refundFailed
    });

  } catch (error) {
    console.error('Check Status Error:', error);
    res.json({ code: 1, msg: '系统错误' });
  }
});

// 支付成功页面
router.get('/success', async (req, res) => {
  try {
    const { trade_no } = req.query;

    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在', code: 'ORDER_NOT_FOUND', backUrl: null });
    }

    const order = orders[0];

    // 使用 EJS 模板渲染成功页面
    res.render('success', { order });

  } catch (error) {
    console.error('Success Page Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

// 获取支付类型列表
router.get('/types', async (req, res) => {
  try {
    const channels = await getChannels();

    const types = channels.map(ch => ({
      id: ch.type_code,
      name: ch.type_name
    }));

    res.json({
      code: 0,
      msg: 'success',
      data: types
    });

  } catch (error) {
    console.error('Types Error:', error);
    res.json({ code: 1, msg: '系统错误' });
  }
});

// 生成RSA密钥对接口
router.post('/generate_keys', async (req, res) => {
  try {
    const keyPair = generateRSAKeyPair();
    res.json({
      code: 0,
      msg: 'success',
      data: {
        public_key: keyPair.publicKey,
        private_key: keyPair.privateKey
      }
    });
  } catch (error) {
    console.error('Generate Keys Error:', error);
    res.json({ code: 1, msg: '生成密钥失败' });
  }
});

// ==================== 统一支付接口（同时支持 V1/V2，根据 timestamp 自动切换）===================

function isBlankParam(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function getMissingRequiredFields(params, requiredFields) {
  return requiredFields.filter((field) => isBlankParam(params[field]));
}

function safeHostFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  try {
    return new URL(rawUrl).host;
  } catch (error) {
    return 'invalid-url';
  }
}

function buildRequestLogSnapshot(params) {
  return {
    pid: params.pid || '',
    out_trade_no: params.out_trade_no || '',
    type: params.type || '',
    money: params.money || '',
    notify_host: safeHostFromUrl(params.notify_url),
    return_host: safeHostFromUrl(params.return_url),
    clientip: params.clientip || '',
    sign_type: params.sign_type || '',
    sign_length: params.sign ? String(params.sign).length : 0,
    fields: Object.keys(params).sort()
  };
}

function logMissingParams(endpoint, req, params, missingFields) {
  console.warn('[PayValidation] Missing required params', {
    endpoint,
    ip: getClientIP(req),
    missing_fields: missingFields,
    request: buildRequestLogSnapshot(params)
  });
}

function logSignContext(endpoint, signType, signParams, providedSign, signValid) {
  console.log('[PayValidation] Sign verify result', {
    endpoint,
    sign_type: signType,
    sign_valid: signValid,
    sign_param_keys: Object.keys(signParams).sort(),
    provided_sign_length: providedSign ? String(providedSign).length : 0
  });
}

// 页面跳转支付处理函数 - 统一处理 /submit 和 /submit.php
async function handleSubmit(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, type, out_trade_no, notify_url, return_url, name, money, sign, sign_type, timestamp, sitename, param, channel_id, cert_no, cert_name, min_age } = params;

    // 判断是否为 V2 模式（/v2/* 路由或显式携带 timestamp）
    const isV2 = req.path.startsWith('/v2/') || !!timestamp;

    // V1 submit: type可选，return_url必填；V2 在此基础上额外要求 timestamp
    const requiredFields = ['pid', 'out_trade_no', 'notify_url', 'return_url', 'name', 'money', 'sign'];
    if (isV2) {
      requiredFields.push('timestamp');
    }
    const missingFields = getMissingRequiredFields(params, requiredFields);
    if (missingFields.length > 0) {
      logMissingParams('submit', req, params, missingFields);
      return res.status(400).json({ code: -1, msg: '缺少必要参数', missing_fields: missingFields });
    }

    // V2 接口验证时间戳
    if (isV2 && !validateTimestamp(timestamp)) {
      return res.status(400).send('时间戳已过期');
    }

    // 验证买家身份限制参数
    const certInfo = buildCertInfo({ cert_no, cert_name, min_age });
    if (certInfo && certInfo.error) {
      return res.status(400).send(certInfo.error);
    }

    // 获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.status(400).send('商户不存在或已禁止');
    }

    // 验证回调域名白名单
    const domainCheck = await validateCallbackDomain(merchant.user_id, notify_url);
    if (!domainCheck.valid) {
      return res.status(400).send(domainCheck.message);
    }
    
    let channel = null;

    // 验证签名
    const signParams = { pid, out_trade_no, notify_url, name, money };
    if (type) signParams.type = type;
    if (return_url) signParams.return_url = return_url;
    if (timestamp) signParams.timestamp = timestamp;
    if (sitename) signParams.sitename = sitename;
    if (param) signParams.param = param;
    if (channel_id) signParams.channel_id = channel_id;

    // 根据 sign_type 选择验签方式
    // V1 默认 MD5，V2 默认 RSA
    const effectiveSignType = sign_type || (isV2 ? 'RSA' : 'MD5');
    let signValid = false;
    if (effectiveSignType === 'RSA') {
      if (!merchant.rsa_public_key) {
        return res.status(400).send('商户未配置RSA公钥，无法使用RSA签名');
      }
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    logSignContext('submit', effectiveSignType, signParams, sign, signValid);
    if (!signValid) {
      return res.status(400).send('签名验证失败');
    }

    const merchantPayGroupId = await resolveMerchantPayGroupId(merchant);

    // 如果指定了type，验证支付通道
    if (type) {
      if (channel_id) {
        const [channels] = await db.query(
          'SELECT *, pay_type as type_code, min_money as min_amount, max_money as max_amount FROM provider_channels WHERE id = ? AND status = 1',
          [channel_id]
        );
        channel = channels[0];
      } else {
        channel = await getChannel(type, merchantPayGroupId);
      }
      if (!channel) {
        return res.status(400).send('支付通道不存在或已关闭');
      }

      // 检查金额限制（只有限额大于0时才检查）
      const moneyFloat = parseFloat(money);
      const minAmount = parseFloat(channel.min_amount) || 0;
      const maxAmount = parseFloat(channel.max_amount) || 0;
      if (minAmount > 0 && moneyFloat < minAmount) {
        return res.status(400).send(`支付金额不能小于 ${minAmount} 元`);
      }
      if (maxAmount > 0 && moneyFloat > maxAmount) {
        return res.status(400).send(`支付金额不能大于 ${maxAmount} 元`);
      }
    }

    // 获取费率：商户个人费率优先，否则用支付组费率
    const feeRate = type ? await getMerchantFeeRate(merchant, type) : 0;
    const feePayer = merchant.fee_payer || 'merchant';

    // 创建订单（或复用已存在的未支付订单）
    const clientIp = getClientIP(req);
    const moneyFloat = parseFloat(money);
    
    const orderResult = await createOrder({
      merchantId: merchant.user_id,  // orders.merchant_id 存储 users.id
      channelId: channel ? channel.id : null,
      tradeNo: generateTradeNo(),
      outTradeNo: out_trade_no,
      type: type || '',
      name,
      money: moneyFloat,
      clientIp,
      device: 'pc',
      notifyUrl: notify_url,
      returnUrl: return_url || '',
      feeRate,
      feePayer,
      orderType: 'normal',
      cryptoPid: null,
      payGroupIdSnapshot: merchantPayGroupId,
      certInfo  // 买家身份限制信息
    });
    const tradeNo = orderResult.tradeNo;

    // 重定向到收银台（使用相对路径），透传 pay_type 以启用直连页面
    const payTypeQuery = type ? `&pay_type=${encodeURIComponent(type)}` : '';
    res.redirect(`/api/pay/cashier?trade_no=${tradeNo}${payTypeQuery}`);

  } catch (error) {
    console.error('Submit Error:', error);
    res.status(500).send('系统错误');
  }
}

// API接口支付处理函数 - 统一处理 /mapi 和 /mapi.php
async function handleMapi(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, type, out_trade_no, notify_url, return_url, name, money, sign, sign_type, timestamp, device, clientip, method, sitename, param, channel_id, sub_openid, sub_appid, auth_code, cert_no, cert_name, min_age } = params;

    // 判断是否为 V2 模式（/v2/* 路由或显式携带 timestamp）
    const isV2 = req.path.startsWith('/v2/') || !!timestamp;

    // V1 mapi: type和clientip必填；V2 在此基础上额外要求 timestamp
    const requiredFields = ['pid', 'type', 'out_trade_no', 'notify_url', 'name', 'money', 'clientip', 'sign'];
    if (isV2) {
      requiredFields.push('timestamp');
    }
    const missingFields = getMissingRequiredFields(params, requiredFields);
    if (missingFields.length > 0) {
      logMissingParams('mapi', req, params, missingFields);
      return res.json({ code: -1, msg: '缺少必要参数', missing_fields: missingFields });
    }

    // V2 接口验证时间戳
    if (isV2 && !validateTimestamp(timestamp)) {
      return res.json({ code: -1, msg: '时间戳已过期' });
    }

    // 验证买家身份限制参数
    const certInfo = buildCertInfo({ cert_no, cert_name, min_age });
    if (certInfo && certInfo.error) {
      return res.json({ code: -1, msg: certInfo.error });
    }

    // 获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.json({ code: -1, msg: '商户不存在或已禁止' });
    }

    // 验证回调域名白名单
    const domainCheck = await validateCallbackDomain(merchant.user_id, notify_url);
    if (!domainCheck.valid) {
      return res.json({ code: -1, msg: domainCheck.message });
    }

    // 验证签名
    const signParams = { pid, out_trade_no, notify_url, name, money };
    if (type) signParams.type = type;
    if (return_url) signParams.return_url = return_url;
    if (timestamp) signParams.timestamp = timestamp;
    if (device) signParams.device = device;
    if (clientip) signParams.clientip = clientip;
    if (method) signParams.method = method;
    if (sitename) signParams.sitename = sitename;
    if (param) signParams.param = param;
    if (channel_id) signParams.channel_id = channel_id;
    if (sub_openid) signParams.sub_openid = sub_openid;
    if (sub_appid) signParams.sub_appid = sub_appid;
    if (auth_code) signParams.auth_code = auth_code;

    // 根据 sign_type 选择验签方式
    // V1 默认 MD5，V2 默认 RSA
    const effectiveSignType = sign_type || (isV2 ? 'RSA' : 'MD5');
    let signValid = false;
    if (effectiveSignType === 'RSA') {
      if (!merchant.rsa_public_key) {
        return res.json({ code: -1, msg: '商户未配置RSA公钥，无法使用RSA签名' });
      }
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    logSignContext('mapi', effectiveSignType, signParams, sign, signValid);
    if (!signValid) {
      return res.json({ code: -1, msg: '签名验证失败' });
    }

    const merchantPayGroupId = await resolveMerchantPayGroupId(merchant);

    // 获取支付通道
    let channel = null;
    if (type) {
      if (channel_id) {
        const [channels] = await db.query(
          'SELECT *, pay_type as type_code, min_money as min_amount, max_money as max_amount FROM provider_channels WHERE id = ? AND status = 1',
          [channel_id]
        );
        channel = channels[0];
      } else {
        channel = await getChannel(type, merchantPayGroupId);
      }
      if (!channel) {
        return res.json({ code: -1, msg: '支付通道不存在或已关闭' });
      }

      // 检查金额限制（只有限额大于0时才检查）
      const moneyFloat = parseFloat(money);
      const minAmount = parseFloat(channel.min_amount) || 0;
      const maxAmount = parseFloat(channel.max_amount) || 0;
      if (minAmount > 0 && moneyFloat < minAmount) {
        return res.json({ code: -1, msg: `支付金额不能小于 ${minAmount} 元` });
      }
      if (maxAmount > 0 && moneyFloat > maxAmount) {
        return res.json({ code: -1, msg: `支付金额不能大于 ${maxAmount} 元` });
      }
    }

    // 获取费率：商户个人费率优先，否则用支付组费率
    const feeRate = type ? await getMerchantFeeRate(merchant, type) : 0;
    const feePayer = merchant.fee_payer || 'merchant';

    // 创建订单（或复用已存在的未支付订单）
    const orderClientIp = clientip || getClientIP(req);
    const moneyFloat = parseFloat(money);
    
    const orderResult = await createOrder({
      merchantId: merchant.user_id,  // orders.merchant_id 存储 users.id
      channelId: channel ? channel.id : null,
      tradeNo: generateTradeNo(),
      outTradeNo: out_trade_no,
      type: type || '',
      name,
      money: moneyFloat,
      clientIp: orderClientIp,
      device: device || 'pc',
      notifyUrl: notify_url,
      returnUrl: return_url || '',
      feeRate,
      feePayer,
      orderType: 'normal',
      cryptoPid: null,
      payGroupIdSnapshot: merchantPayGroupId,
      certInfo  // 买家身份限制信息
    });
    const tradeNo = orderResult.tradeNo;

    // 保存额外参数
    if (sub_openid || sub_appid || auth_code || param) {
      const extendParams = JSON.stringify({ sub_openid, sub_appid, auth_code, param });
      await db.query(
        'UPDATE orders SET param = ? WHERE trade_no = ?',
        [extendParams, tradeNo]
      );
    }

    // 根据method决定返回方式（使用请求的域名）
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    const cashierUrl = `${baseUrl}/api/pay/cashier?trade_no=${tradeNo}${type ? `&pay_type=${encodeURIComponent(type)}` : ''}`;
    const methodType = method || 'web';
    
    let payType = 'jump';
    let payInfo = cashierUrl;
    
    switch (methodType) {
      case 'scan':
        payType = 'qrcode';
        payInfo = `${baseUrl}/api/pay/qrcode?trade_no=${tradeNo}`;
        break;
      case 'jsapi':
        payType = 'jsapi';
        payInfo = `${baseUrl}/api/pay/jsapi?trade_no=${tradeNo}`;
        break;
      case 'app':
        payType = 'app';
        payInfo = `${baseUrl}/api/pay/app?trade_no=${tradeNo}`;
        break;
      default:
        payType = 'jump';
        payInfo = cashierUrl;
    }

    // 根据是否为 timestamp 决定响应格式
    if (isV2) {
      // V2 响应格式（code=0表示成功）
      const responseTimestamp = Math.floor(Date.now() / 1000);
      const responseData = {
        code: 0,
        trade_no: tradeNo,
        pay_type: payType,
        pay_info: payInfo,
        timestamp: responseTimestamp.toString(),
        sign_type: 'RSA'
      };
      // 如果平台配置了RSA私钥，则对响应签名
      if (merchant.rsa_private_key) {
        responseData.sign = makeSignRSA(responseData, merchant.rsa_private_key);
      }
      res.json(responseData);
    } else {
      // V1 响应格式（code=1表示成功）
      res.json({
        code: 1,
        msg: 'success',
        trade_no: tradeNo,
        payurl: cashierUrl,
        qrcode: '',
        urlscheme: ''
      });
    }

  } catch (error) {
    console.error('MAPI Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
}

// 订单查询处理函数 - 统一处理 /query 和 /api.php?act=order
async function handleQuery(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, trade_no, out_trade_no, sign, sign_type, timestamp } = params;

    // 判断是否为 V2 模式（/v2/* 路由或显式携带 timestamp）
    const isV2 = req.path.startsWith('/v2/') || !!timestamp;

    const queryRequired = ['pid', 'sign'];
    if (isV2) {
      queryRequired.push('timestamp');
    }
    const missingFields = getMissingRequiredFields(params, queryRequired);
    if (missingFields.length > 0) {
      logMissingParams('query', req, params, missingFields);
      return res.json({ code: -1, msg: '缺少必要参数', missing_fields: missingFields });
    }

    if (!trade_no && !out_trade_no) {
      return res.json({ code: -1, msg: '订单号不能为空' });
    }

    // V2 接口验证时间戳
    if (isV2 && !validateTimestamp(timestamp)) {
      return res.json({ code: -1, msg: '时间戳已过期' });
    }

    // 通过PID获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.json({ code: -1, msg: '商户不存在或已禁止' });
    }

    // 验证签名
    const signParams = { pid };
    if (trade_no) signParams.trade_no = trade_no;
    if (out_trade_no) signParams.out_trade_no = out_trade_no;
    if (timestamp) signParams.timestamp = timestamp;

    // V1 默认 MD5，V2 默认 RSA
    const effectiveSignType = sign_type || (isV2 ? 'RSA' : 'MD5');
    let signValid = false;
    if (effectiveSignType === 'RSA') {
      if (!merchant.rsa_public_key) {
        return res.json({ code: -1, msg: '商户未配置RSA公钥，无法使用RSA签名' });
      }
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    if (!signValid) {
      return res.json({ code: -1, msg: '签名验证失败' });
    }

    // 查询订单
    let query = 'SELECT * FROM orders WHERE merchant_id = ?';
    const queryParams = [merchant.user_id];  // orders.merchant_id 存储的是 users.id
    
    if (trade_no) {
      query += ' AND trade_no = ?';
      queryParams.push(trade_no);
    } else {
      query += ' AND out_trade_no = ?';
      queryParams.push(out_trade_no);
    }

    const [orders] = await db.query(query, queryParams);
    
    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];
    const statusMap = { 0: 0, 1: 1, 2: 2, 3: 3 };

    // 根据是否为 timestamp 决定响应格式
    if (isV2) {
      // V2 响应格式
      const responseTimestamp = Math.floor(Date.now() / 1000);
      const responseData = {
        code: 0,
        msg: 'success',
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        type: order.pay_type,
        pid: pid,
        name: order.name,
        money: order.money,
        status: statusMap[order.status] || 0,
        api_trade_no: order.api_trade_no || '',
        buyer: order.buyer || '',
        param: order.param || '',
        addtime: order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : 0,
        endtime: order.paid_at ? Math.floor(new Date(order.paid_at).getTime() / 1000) : 0,
        timestamp: responseTimestamp.toString(),
        sign_type: 'RSA'
      };
      if (merchant.rsa_private_key) {
        responseData.sign = makeSignRSA(responseData, merchant.rsa_private_key);
      }
      res.json(responseData);
    } else {
      // V1 响应格式
      res.json({
        code: 1,
        msg: 'success',
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        type: order.pay_type,
        name: order.name,
        money: order.money,
        status: statusMap[order.status] || 0,
        addtime: order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : 0,
        endtime: order.paid_at ? Math.floor(new Date(order.paid_at).getTime() / 1000) : 0
      });
    }

  } catch (error) {
    console.error('Query Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
}

// 注册路由 - 使用统一处理函数
router.all('/submit', handleSubmit);      // /api/pay/submit
router.all('/submit.php', handleSubmit);  // /api/pay/submit.php
router.all('/mapi', handleMapi);          // /api/pay/mapi
router.all('/mapi.php', handleMapi);      // /api/pay/mapi.php
router.all('/query', handleQuery);        // /api/pay/query

// 兼容 api.php - 订单查询（带 act 参数量
router.all('/api.php', async (req, res) => {
  const { act } = { ...req.query, ...req.body };
  if (act === 'order') {
    return handleQuery(req, res);
  }
  res.json({ code: -1, msg: '未知操作' });
});

// ==================== 动态支付路由处理 ====================
// 处理 /pay/jspay/:trade_no, /pay/h5/:trade_no, /pay/qrcode/:trade_no 等
router.all('/:func/:trade_no', async (req, res) => {
  try {
    const { func, trade_no } = req.params;
    
    // 验证函数名，只允许特定的支付方法
    const allowedFuncs = [
      'jspay', 'h5', 'qrcode', 'qrcodepc', 'wap', 'apppay', 'submit', 'ok',
      'alipay', 'alipayjs', 'alipayh5', 'alipaywap',
      'wxpay', 'wxjspay', 'wxwappay', 'wxh5pay',
      'qqpay', 'qqwap',
      'bank', 'unionpay'
    ];
    if (!allowedFuncs.includes(func)) {
      return res.status(404).send('Not Found');
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.status(404).render('error', { 
        message: '该订单号不存在，请返回来源地重新发起请求'
      });
    }

    const order = orders[0];

    // 获取通道配置
    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      return res.status(500).render('error', {
        message: '当前支付通道信息不存在'
      });
    }

    const channelConfig = channels[0];
    const pluginName = channelConfig.plugin_name;

    // 获取插件
    const plugin = pluginLoader.getPlugin(pluginName);
    if (!plugin) {
      return res.status(500).render('error', {
        message: '支付插件不存在'
      });
    }

    // 检查插件是否支持该方法
    if (typeof plugin[func] !== 'function') {
      // 如果不支持，跳转到通用提交页面
      if (func === 'ok') {
        return res.render('success', { order, trade_no });
      }
      return res.redirect(`/api/pay/cashier?trade_no=${trade_no}`);
    }

    // 解析通道配置
    let pluginConfig = {};
    let channelConfigJson = {};
    try {
      channelConfigJson = typeof channelConfig.config === 'string' 
        ? JSON.parse(channelConfig.config) 
        : (channelConfig.config || {});
      
      pluginConfig = {
        id: channelConfig.id,
        name: channelConfig.channel_name,
        plugin: channelConfig.plugin_name,
        ...channelConfigJson.params,
        apptype: channelConfigJson.apptype || [],
        config: { certs: channelConfigJson.certs || {} },
        wxmp: channelConfigJson.wxmp || null,
        wxa: channelConfigJson.wxa || null
      };
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 获取基础URL（使用请求的域名）和系统配置
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    const sitename = await systemConfig.getConfig('sitename', '');
    
    // 对于 jspay，需要获取用户 openid
    let openid = req.query.openid || req.session?.openid || null;
    
    if (func === 'jspay' && !openid && pluginConfig.wxmp && pluginConfig.wxmp.appid) {
      // 检查是否有微信回调的 code
      const code = req.query.code;
      if (code) {
        // 用 code 换取 openid
        try {
          const axios = require('axios');
          const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${pluginConfig.wxmp.appid}&secret=${pluginConfig.wxmp.appsecret}&code=${code}&grant_type=authorization_code`;
          const tokenRes = await axios.get(tokenUrl);
          if (tokenRes.data.openid) {
            openid = tokenRes.data.openid;
            // 保存到 session
            if (req.session) {
              req.session.openid = openid;
            }
          } else {
            console.error('获取 openid 失败:', tokenRes.data);
          }
        } catch (e) {
          console.error('微信授权获取 openid 失败:', e.message);
        }
      }
      
      // 如果仍然没有 openid，重定向到微信授权
      if (!openid) {
        const redirectUri = encodeURIComponent(`${baseUrl}pay/jspay/${trade_no}/`);
        const authUrl = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${pluginConfig.wxmp.appid}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=pay#wechat_redirect`;
        return res.redirect(authUrl);
      }
    }
    
    // 构建订单信息
    const realMoney = parseFloat(order.real_money || order.money) || 0;
    const orderInfo = {
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      money: realMoney,
      name: order.name,
      notify_url: `${baseUrl}pay/notify/${order.trade_no}/`,
      return_url: order.return_url || '',
      clientip: getClientIP(req),
      openid: openid,
      method: func
    };

    const conf = {
      siteurl: baseUrl,
      sitename: sitename,
      localurl: baseUrl
    };

    // 调用插件方法
    const result = await plugin[func](pluginConfig, orderInfo, conf);
    
    console.log(`插件 ${func} 返回:`, result);

    // 处理返回结果
    if (result.type === 'error') {
      return res.render('error', {
        message: result.msg || '支付失败',
        code: result.code || null,
        backUrl: orderInfo.return_url || null
      });
    }

    if (result.type === 'jump') {
      return res.redirect(result.url);
    }

    if (result.type === 'page') {
      // 渲染插件指定的页面
      return res.render(result.page, {
        ...result.data,
        order,
        trade_no
      });
    }

    if (result.type === 'qrcode') {
      // 重定向到收银台页面，透传 pay_type 以便直连模式生效
      const payTypeQuery = order.pay_type ? `&pay_type=${encodeURIComponent(order.pay_type)}` : '';
      return res.redirect(`/api/pay/cashier?trade_no=${trade_no}${payTypeQuery}`);
    }

    if (result.type === 'jsapi') {
      // JSAPI 支付 - 直接返回内联 HTML 页面
      const jsapiHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>微信支付</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); padding: 40px; max-width: 400px; width: 100%; text-align: center; }
    .logo { width: 80px; height: 80px; background: #07c160; border-radius: 50%; margin: 0 auto 24px; display: flex; align-items: center; justify-content: center; }
    .logo svg { width: 48px; height: 48px; fill: #fff; }
    .title { font-size: 18px; color: #333; margin-bottom: 8px; }
    .amount { font-size: 36px; font-weight: 700; color: #07c160; margin-bottom: 24px; }
    .amount::before { content: '¥'; font-size: 24px; }
    .btn { display: block; width: 100%; padding: 16px; background: #07c160; color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }
    .btn:disabled { background: #ccc; }
    .status { margin-top: 16px; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"><svg viewBox="0 0 24 24"><path d="M8.5 5c-2.5 0-4.5 1.7-4.5 3.8 0 1.2.7 2.3 1.8 3l-.5 1.5 1.8-1c.4.1.9.2 1.4.2.2 0 .4 0 .6 0-.1-.4-.2-.8-.2-1.2C8.9 9.3 10.9 7.5 13.5 7.5c.3 0 .5 0 .8.1C13.6 5.9 11.3 5 8.5 5zM6 7.5c-.4 0-.8.3-.8.8s.3.8.8.8.8-.3.8-.8-.4-.8-.8-.8zm5 0c-.4 0-.8.3-.8.8s.3.8.8.8.8-.3.8-.8-.4-.8-.8-.8zm2.5 1.5c-2.2 0-4 1.5-4 3.3 0 1.8 1.8 3.3 4 3.3.4 0 .8-.1 1.2-.2l1.4.8-.4-1.3c.9-.6 1.5-1.5 1.5-2.5 0-1.9-1.8-3.4-3.7-3.4zm-1.3 2c.3 0 .6.3.6.6s-.3.6-.6.6-.6-.3-.6-.6.3-.6.6-.6zm2.6 0c.3 0 .6.3.6.6s-.3.6-.6.6-.6-.3-.6-.6.3-.6.6-.6z"/></svg></div>
    <h1 class="title">${order.name}</h1>
    <div class="amount">${parseFloat(realMoney).toFixed(2)}</div>
    <button id="payBtn" class="btn">立即支付</button>
    <p id="status" class="status"></p>
  </div>
  <script>
    var jsApiParams = ${JSON.stringify(result.data)};
    var redirectUrl = '${result.redirect_url || `/pay/ok/${trade_no}/`}';
    document.getElementById('payBtn').addEventListener('click', function() {
      var btn = this, status = document.getElementById('status');
      if (typeof WeixinJSBridge === 'undefined') { status.textContent = '请在微信中打开此页面'; return; }
      btn.disabled = true; btn.textContent = '支付中...';
      WeixinJSBridge.invoke('getBrandWCPayRequest', jsApiParams, function(res) {
        if (res.err_msg === 'get_brand_wcpay_request:ok') {
          status.textContent = '支付成功，正在跳转...'; status.style.color = '#07c160';
          setTimeout(function() { window.location.href = redirectUrl; }, 1500);
        } else if (res.err_msg === 'get_brand_wcpay_request:cancel') {
          btn.disabled = false; btn.textContent = '立即支付'; status.textContent = '支付已取消';
        } else {
          btn.disabled = false; btn.textContent = '立即支付'; status.textContent = '支付失败';
        }
      });
    });
    if (typeof WeixinJSBridge !== 'undefined') { document.getElementById('payBtn').click(); }
  </script>
</body>
</html>`;
      return res.send(jsapiHtml);
    }

    if (result.type === 'scheme') {
      // 重定向到收银台页面，透传 pay_type 以便直连模式生效
      const payTypeQuery = order.pay_type ? `&pay_type=${encodeURIComponent(order.pay_type)}` : '';
      return res.redirect(`/api/pay/cashier?trade_no=${trade_no}${payTypeQuery}`);
    }

    // 默认跳转
    if (result.url) {
      return res.redirect(result.url);
    }

    {
      const payTypeQuery = order.pay_type ? `&pay_type=${encodeURIComponent(order.pay_type)}` : '';
      return res.redirect(`/api/pay/cashier?trade_no=${trade_no}${payTypeQuery}`);
    }

  } catch (error) {
    console.error('动态支付路由错误:', error);
    return res.status(500).render('error', {
      message: error.message || '系统错误，请稍后重试'
    });
  }
});

module.exports = router;
