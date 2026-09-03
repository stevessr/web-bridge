import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'models/account_route.dart';
import 'services/rust_core_bridge.dart';

class HistoryPage extends StatefulWidget {
  const HistoryPage({
    required this.bridge,
    required this.account,
    super.key,
  });

  final RustCoreBridge bridge;
  final AccountRoute account;

  @override
  State<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends State<HistoryPage> {
  final _conversations = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;

  Map<String, dynamic> get _accountRef => <String, dynamic>{
    'network': widget.account.network.name,
    'id': widget.account.accountId,
  };

  @override
  void initState() {
    super.initState();
    unawaited(_loadConversations());
  }

  Future<void> _loadConversations() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final frame = await widget.bridge.executeAndWait(<String, dynamic>{
        'type': 'list_conversations',
        'account': _accountRef,
        'limit': 200,
      });
      if (!mounted) {
        return;
      }
      if (frame['type'] == 'error') {
        throw StateError('${frame['code']}: ${frame['message']}');
      }
      final raw = frame['conversations'];
      if (raw is! List) {
        throw const FormatException('Conversation response has invalid shape');
      }
      final items = raw
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .where(_belongsToAccount)
          .toList(growable: false);
      setState(() {
        _conversations
          ..clear()
          ..addAll(items);
        _loading = false;
        _error = null;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = error.toString();
        });
      }
    }
  }

  bool _belongsToAccount(Map<String, dynamic> snapshot) {
    final account = snapshot['account'];
    return account is Map &&
        account['network'] == widget.account.network.name &&
        account['id'] == widget.account.accountId;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.account.label} history'),
        actions: [
          IconButton(
            onPressed: _loading ? null : _loadConversations,
            tooltip: 'Refresh history',
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: switch ((_loading, _error)) {
        (true, _) => const Center(child: CircularProgressIndicator()),
        (false, final String error) => _ErrorView(
          message: error,
          onRetry: _loadConversations,
        ),
        _ when _conversations.isEmpty => const Center(
          child: Text('No stored conversations for this account.'),
        ),
        _ => ListView.separated(
          itemCount: _conversations.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, index) {
            final snapshot = _conversations[index];
            final conversation = snapshot['conversation'];
            if (conversation is! Map) {
              return const SizedBox.shrink();
            }
            final kind = conversation['kind']?.toString() ?? 'conversation';
            final id = conversation['id']?.toString() ?? '';
            final lastMessageAt = snapshot['last_message_at']?.toString();
            return ListTile(
              leading: const Icon(Icons.forum_outlined),
              title: Text(id),
              subtitle: Text(
                lastMessageAt == null
                    ? kind
                    : '$kind · ${_displayTimestamp(lastMessageAt)}',
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: id.isEmpty
                  ? null
                  : () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => MessageHistoryPage(
                          bridge: widget.bridge,
                          account: widget.account,
                          conversation: <String, dynamic>{
                            'kind': kind,
                            'id': id,
                          },
                        ),
                      ),
                    ),
            );
          },
        ),
      },
    );
  }
}

class MessageHistoryPage extends StatefulWidget {
  const MessageHistoryPage({
    required this.bridge,
    required this.account,
    required this.conversation,
    super.key,
  });

  final RustCoreBridge bridge;
  final AccountRoute account;
  final Map<String, dynamic> conversation;

  @override
  State<MessageHistoryPage> createState() => _MessageHistoryPageState();
}

class _MessageHistoryPageState extends State<MessageHistoryPage> {
  StreamSubscription<CoreFrame>? _subscription;
  final _messages = <Map<String, dynamic>>[];
  final _composerController = TextEditingController();
  bool _loading = true;
  bool _loadingOlder = false;
  bool _sending = false;
  String? _error;
  String? _replyMessageId;
  String? _mentionId;
  String? _mentionDisplayName;
  Map<String, dynamic>? _attachment;

  Map<String, dynamic> get _accountRef => <String, dynamic>{
    'network': widget.account.network.name,
    'id': widget.account.accountId,
  };

  @override
  void initState() {
    super.initState();
    _subscription = widget.bridge.events.listen(_handleEvent);
    unawaited(_loadMessages());
  }

  Future<void> _loadMessages({bool older = false}) async {
    if (_loadingOlder || (_loading && older)) {
      return;
    }
    final before = older && _messages.isNotEmpty
        ? _messages.first['timestamp']?.toString()
        : null;
    if (mounted) {
      setState(() {
        if (older) {
          _loadingOlder = true;
        } else {
          _loading = true;
          _error = null;
        }
      });
    }
    try {
      final frame = await widget.bridge.executeAndWait(<String, dynamic>{
        'type': 'list_messages',
        'account': _accountRef,
        'conversation': widget.conversation,
        'before': before,
        'limit': 50,
      });
      if (!mounted) {
        return;
      }
      if (frame['type'] == 'error') {
        throw StateError('${frame['code']}: ${frame['message']}');
      }
      final raw = frame['messages'];
      if (raw is! List) {
        throw const FormatException('Messages response has invalid shape');
      }
      final items = raw
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .where(_belongsToConversation)
          .toList(growable: false);
      setState(() {
        if (older) {
          final knownIds = _messages
              .map((message) => message['id'])
              .whereType<String>()
              .toSet();
          _messages.insertAll(
            0,
            items.where((message) => !knownIds.contains(message['id'])),
          );
        } else {
          _messages
            ..clear()
            ..addAll(items);
        }
        _loading = false;
        _loadingOlder = false;
        _error = null;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _loadingOlder = false;
          _error = error.toString();
        });
      }
    }
  }

  void _handleEvent(CoreFrame frame) {
    if (!mounted || frame['type'] != 'message') {
      return;
    }
    final rawMessage = frame['message'];
    if (rawMessage is! Map) {
      return;
    }
    final message = Map<String, dynamic>.from(rawMessage);
    if (!_belongsToConversation(message)) {
      return;
    }
    setState(() {
      final id = message['id']?.toString();
      final index = _messages.indexWhere(
        (existing) => existing['id']?.toString() == id,
      );
      if (index >= 0) {
        _messages[index] = message;
      } else {
        _messages.add(message);
      }
    });
  }

  bool _belongsToConversation(Map<String, dynamic> message) {
    final account = message['account'];
    final conversation = message['conversation'];
    return account is Map &&
        conversation is Map &&
        account['network'] == widget.account.network.name &&
        account['id'] == widget.account.accountId &&
        conversation['kind'] == widget.conversation['kind'] &&
        conversation['id'] == widget.conversation['id'];
  }

  Future<void> _pickAttachment() async {
    if (_sending) {
      return;
    }
    try {
      final file = await FilePicker.pickFile();
      if (file == null || !mounted) {
        return;
      }
      final path = file.path;
      if (path == null || path.isEmpty) {
        throw StateError(
          'This attachment source has no native file path. Use the native client file picker.',
        );
      }
      setState(() => _sending = true);
      final uploaded = await widget.bridge.uploadMedia(
        network: widget.account.network.name,
        accountId: widget.account.accountId,
        route: widget.account.mode.name,
        path: path,
        filename: file.name,
      );
      if (!mounted) {
        return;
      }
      setState(() {
        _attachment = uploaded;
        _sending = false;
        _error = null;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _sending = false;
          _error = error.toString();
        });
      }
    }
  }

  Future<void> _chooseMention() async {
    final idController = TextEditingController(text: _mentionId);
    final nameController = TextEditingController(text: _mentionDisplayName);
    final result = await showDialog<(String, String?)>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Insert mention'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: idController,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'User ID / @username',
              ),
            ),
            TextField(
              controller: nameController,
              decoration: const InputDecoration(labelText: 'Display name (optional)'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              final id = idController.text.trim();
              if (id.isEmpty) {
                return;
              }
              final name = nameController.text.trim();
              Navigator.of(context).pop((id, name.isEmpty ? null : name));
            },
            child: const Text('Insert'),
          ),
        ],
      ),
    );
    idController.dispose();
    nameController.dispose();
    if (result != null && mounted) {
      setState(() {
        _mentionId = result.$1;
        _mentionDisplayName = result.$2;
      });
    }
  }

  Future<void> _send() async {
    if (_sending) {
      return;
    }
    final text = _composerController.text;
    final parts = <Map<String, dynamic>>[];
    if (_replyMessageId != null) {
      parts.add(<String, dynamic>{
        'type': 'reply',
        'message_id': _replyMessageId,
      });
    }
    if (text.isNotEmpty) {
      parts.add(<String, dynamic>{'type': 'text', 'text': text});
    }
    if (_mentionId != null) {
      parts.add(<String, dynamic>{
        'type': 'mention',
        'id': _mentionId,
        'display_name': _mentionDisplayName,
      });
    }
    final attachment = _attachment;
    if (attachment != null) {
      final reference = attachment['reference']?.toString();
      if (reference == null || reference.isEmpty) {
        setState(() => _error = 'Uploaded media has no media reference');
        return;
      }
      final contentType = attachment['content_type']?.toString() ?? '';
      if (contentType.startsWith('image/')) {
        parts.add(<String, dynamic>{
          'type': 'image',
          'url': reference,
          'alt': attachment['name']?.toString(),
        });
      } else {
        parts.add(<String, dynamic>{
          'type': 'file',
          'url': reference,
          'name': attachment['name']?.toString(),
        });
      }
    }
    if (parts.isEmpty) {
      return;
    }

    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final frame = await widget.bridge.executeAndWait(<String, dynamic>{
        'type': 'send_message',
        'account': _accountRef,
        'route': widget.account.mode.name,
        'conversation': widget.conversation,
        'parts': parts,
      });
      if (frame['type'] == 'error') {
        throw StateError('${frame['code']}: ${frame['message']}');
      }
      if (!mounted) {
        return;
      }
      setState(() {
        _composerController.clear();
        _replyMessageId = null;
        _mentionId = null;
        _mentionDisplayName = null;
        _attachment = null;
        _sending = false;
      });
      await _loadMessages();
    } catch (error) {
      if (mounted) {
        setState(() {
          _sending = false;
          _error = error.toString();
        });
      }
    }
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _composerController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final conversationId = widget.conversation['id']?.toString() ?? 'Conversation';
    return Scaffold(
      appBar: AppBar(title: Text(conversationId)),
      body: switch ((_loading, _error)) {
        (true, _) => const Center(child: CircularProgressIndicator()),
        (false, final String error) when _messages.isEmpty => _ErrorView(
          message: error,
          onRetry: _loadMessages,
        ),
        _ => Column(
          children: [
            if (_error != null)
              MaterialBanner(
                content: Text(_error!),
                actions: [
                  TextButton(
                    onPressed: () => setState(() => _error = null),
                    child: const Text('Dismiss'),
                  ),
                ],
              ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: TextButton.icon(
                onPressed: _loadingOlder || _messages.isEmpty
                    ? null
                    : () => _loadMessages(older: true),
                icon: _loadingOlder
                    ? const SizedBox.square(
                        dimension: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.history),
                label: const Text('Load older'),
              ),
            ),
            Expanded(
              child: _messages.isEmpty
                  ? const Center(child: Text('No stored messages.'))
                  : ListView.builder(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
                      itemCount: _messages.length,
                      itemBuilder: (context, index) => _MessageCard(
                        message: _messages[index],
                        onReply: (messageId) => setState(
                          () => _replyMessageId = messageId,
                        ),
                      ),
                    ),
            ),
            _Composer(
              controller: _composerController,
              sending: _sending,
              replyMessageId: _replyMessageId,
              mentionId: _mentionId,
              attachment: _attachment,
              onCancelReply: () => setState(() => _replyMessageId = null),
              onCancelMention: () => setState(() {
                _mentionId = null;
                _mentionDisplayName = null;
              }),
              onRemoveAttachment: () => setState(() => _attachment = null),
              onPickAttachment: _pickAttachment,
              onMention: _chooseMention,
              onSend: _send,
            ),
          ],
        ),
      },
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.sending,
    required this.replyMessageId,
    required this.mentionId,
    required this.attachment,
    required this.onCancelReply,
    required this.onCancelMention,
    required this.onRemoveAttachment,
    required this.onPickAttachment,
    required this.onMention,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool sending;
  final String? replyMessageId;
  final String? mentionId;
  final Map<String, dynamic>? attachment;
  final VoidCallback onCancelReply;
  final VoidCallback onCancelMention;
  final VoidCallback onRemoveAttachment;
  final Future<void> Function() onPickAttachment;
  final Future<void> Function() onMention;
  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Material(
        elevation: 3,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  if (replyMessageId != null)
                    InputChip(
                      avatar: const Icon(Icons.reply, size: 16),
                      label: Text('Reply $replyMessageId'),
                      onDeleted: sending ? null : onCancelReply,
                    ),
                  if (mentionId != null)
                    InputChip(
                      avatar: const Icon(Icons.alternate_email, size: 16),
                      label: Text('Mention $mentionId'),
                      onDeleted: sending ? null : onCancelMention,
                    ),
                  if (attachment != null)
                    InputChip(
                      avatar: const Icon(Icons.attach_file, size: 16),
                      label: Text(
                        attachment!['name']?.toString() ?? 'attachment',
                      ),
                      onDeleted: sending ? null : onRemoveAttachment,
                    ),
                ],
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    onPressed: sending ? null : onPickAttachment,
                    tooltip: 'Attach file',
                    icon: const Icon(Icons.attach_file),
                  ),
                  IconButton(
                    onPressed: sending ? null : onMention,
                    tooltip: 'Mention',
                    icon: const Icon(Icons.alternate_email),
                  ),
                  Expanded(
                    child: TextField(
                      controller: controller,
                      enabled: !sending,
                      minLines: 1,
                      maxLines: 5,
                      textInputAction: TextInputAction.newline,
                      decoration: const InputDecoration(
                        hintText: 'Message',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  IconButton.filled(
                    onPressed: sending ? null : onSend,
                    tooltip: 'Send',
                    icon: sending
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.send),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.message, required this.onReply});

  final Map<String, dynamic> message;
  final ValueChanged<String> onReply;

  @override
  Widget build(BuildContext context) {
    final sender = message['sender_name']?.toString();
    final senderId = message['sender_id']?.toString() ?? 'unknown';
    final timestamp = message['timestamp']?.toString();
    final messageId = message['id']?.toString();
    final rawParts = message['parts'];
    final parts = rawParts is List
        ? rawParts
              .whereType<Map>()
              .map((part) => Map<String, dynamic>.from(part))
              .toList(growable: false)
        : const <Map<String, dynamic>>[];

    return Card.outlined(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    sender?.isNotEmpty == true ? '$sender · $senderId' : senderId,
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                ),
                if (timestamp != null)
                  Text(
                    _displayTimestamp(timestamp),
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                if (messageId != null && messageId.isNotEmpty)
                  IconButton(
                    onPressed: () => onReply(messageId),
                    tooltip: 'Reply',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.reply, size: 18),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            if (parts.isEmpty)
              const Text('[No displayable message parts]')
            else
              for (final part in parts) ...[
                Text(_renderPart(part)),
                const SizedBox(height: 4),
              ],
          ],
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton.tonal(
              onPressed: onRetry,
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}

String _renderPart(Map<String, dynamic> part) {
  switch (part['type']) {
    case 'text':
      return part['text']?.toString() ?? '';
    case 'image':
      final alt = part['alt']?.toString();
      return '[Image] ${alt?.isNotEmpty == true ? alt : part['url'] ?? ''}';
    case 'file':
      final name = part['name']?.toString();
      return '[File] ${name?.isNotEmpty == true ? name : part['url'] ?? ''}';
    case 'mention':
      final displayName = part['display_name']?.toString();
      final id = part['id']?.toString() ?? '';
      return displayName?.isNotEmpty == true ? '@$displayName ($id)' : id;
    case 'reply':
      return '↩ Reply to ${part['message_id'] ?? ''}';
    case 'unsupported':
      return '[Unsupported message part]';
    default:
      return '[Unknown message part]';
  }
}

String _displayTimestamp(String value) {
  final parsed = DateTime.tryParse(value);
  if (parsed == null) {
    return value;
  }
  return parsed.toLocal().toString();
}
