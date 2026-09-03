import 'dart:async';

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
  StreamSubscription<CoreFrame>? _subscription;
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
    _subscription = widget.bridge.events.listen(_handleFrame);
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
      await widget.bridge.execute(<String, dynamic>{
        'type': 'list_conversations',
        'account': _accountRef,
        'limit': 200,
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

  void _handleFrame(CoreFrame frame) {
    if (!mounted) {
      return;
    }
    switch (frame['type']) {
      case 'conversations':
        if (!_loading) {
          return;
        }
        final raw = frame['conversations'];
        if (raw is! List) {
          return;
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
      case 'error':
        if (_loading && frame['request_id'] != null) {
          setState(() {
            _loading = false;
            _error = '${frame['code']}: ${frame['message']}';
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
  void dispose() {
    _subscription?.cancel();
    super.dispose();
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
  bool _loading = true;
  bool _loadingOlder = false;
  String? _error;

  Map<String, dynamic> get _accountRef => <String, dynamic>{
    'network': widget.account.network.name,
    'id': widget.account.accountId,
  };

  @override
  void initState() {
    super.initState();
    _subscription = widget.bridge.events.listen(_handleFrame);
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
      await widget.bridge.execute(<String, dynamic>{
        'type': 'list_messages',
        'account': _accountRef,
        'conversation': widget.conversation,
        'before': before,
        'limit': 50,
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

  void _handleFrame(CoreFrame frame) {
    if (!mounted) {
      return;
    }
    switch (frame['type']) {
      case 'messages':
        if (!_loading && !_loadingOlder) {
          return;
        }
        final raw = frame['messages'];
        if (raw is! List) {
          return;
        }
        final items = raw
            .whereType<Map>()
            .map((item) => Map<String, dynamic>.from(item))
            .where(_belongsToConversation)
            .toList(growable: false);
        setState(() {
          if (_loadingOlder) {
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
      case 'error':
        if ((_loading || _loadingOlder) && frame['request_id'] != null) {
          setState(() {
            _loading = false;
            _loadingOlder = false;
            _error = '${frame['code']}: ${frame['message']}';
          });
        }
    }
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

  @override
  void dispose() {
    _subscription?.cancel();
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
                      ),
                    ),
            ),
          ],
        ),
      },
    );
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.message});

  final Map<String, dynamic> message;

  @override
  Widget build(BuildContext context) {
    final sender = message['sender_name']?.toString();
    final senderId = message['sender_id']?.toString() ?? 'unknown';
    final timestamp = message['timestamp']?.toString();
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
      return '@${displayName?.isNotEmpty == true ? displayName : part['id'] ?? ''}';
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
