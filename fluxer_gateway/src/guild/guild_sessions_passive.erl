%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_sessions_passive).
-typing([eqwalizer]).

-export([
    set_session_active_guild/3,
    set_session_passive_guild/3,
    is_session_active/2,
    handle_set_typing_override/3,
    handle_send_guild_sync/2,
    force_guild_sync_all/1,
    handle_send_members_chunk/3
]).

-type guild_state() :: map().
-type session_id() :: binary().
-type guild_id() :: integer().
-export_type([guild_state/0, session_id/0, guild_id/0]).

-spec set_session_active_guild(session_id(), guild_id(), guild_state()) -> guild_state().
set_session_active_guild(SessionId, GuildId, State) ->
    case snowflake_id:parse_optional(GuildId) of
        undefined ->
            State;
        ValidGuildId ->
            set_active_for_session(SessionId, ValidGuildId, State)
    end.

-spec set_active_for_session(session_id(), guild_id(), guild_state()) -> guild_state().
set_active_for_session(SessionId, ValidGuildId, State) ->
    update_session(SessionId, State, fun(SD) ->
        session_passive:set_active(ValidGuildId, SD)
    end).

-spec set_session_passive_guild(session_id(), guild_id(), guild_state()) -> guild_state().
set_session_passive_guild(SessionId, GuildId, State) ->
    case snowflake_id:parse_optional(GuildId) of
        undefined ->
            State;
        ValidGuildId ->
            set_passive_for_session(SessionId, ValidGuildId, State)
    end.

-spec set_passive_for_session(session_id(), guild_id(), guild_state()) -> guild_state().
set_passive_for_session(SessionId, ValidGuildId, State) ->
    update_session(SessionId, State, fun(SD) ->
        NewSD = session_passive:set_passive(ValidGuildId, SD),
        session_passive:clear_guild_synced(ValidGuildId, NewSD)
    end).

-spec is_session_active(session_id(), guild_state()) -> boolean().
is_session_active(SessionId, State) ->
    case guild_session(SessionId, State) of
        {GuildId, _Sessions, SessionData} ->
            not session_passive:is_passive(GuildId, SessionData);
        undefined ->
            false
    end.

-spec handle_set_typing_override(session_id(), boolean(), guild_state()) -> guild_state().
handle_set_typing_override(SessionId, TypingFlag, State) ->
    case guild_session(SessionId, State) of
        {GuildId, Sessions, SessionData} ->
            NewSD = session_passive:set_typing_override(GuildId, TypingFlag, SessionData),
            State#{sessions => Sessions#{SessionId => NewSD}};
        undefined ->
            State
    end.

-spec handle_send_guild_sync(session_id(), guild_state()) -> guild_state().
handle_send_guild_sync(SessionId, State) ->
    case guild_session(SessionId, State) of
        {GuildId, Sessions, SessionData} ->
            maybe_dispatch_guild_sync(SessionId, SessionData, GuildId, Sessions, State);
        undefined ->
            State
    end.

-spec force_guild_sync_all(guild_state()) -> {non_neg_integer(), guild_state()}.
force_guild_sync_all(State) ->
    case guild_id(State) of
        undefined ->
            {0, State};
        GuildId ->
            SessionIds = maps:keys(maps:get(sessions, State, #{})),
            lists:foldl(
                fun(SessionId, Acc) -> force_guild_sync_session(SessionId, GuildId, Acc) end,
                {0, State},
                SessionIds
            )
    end.

-spec maybe_dispatch_guild_sync(
    session_id(), map(), guild_id(), map(), guild_state()
) -> guild_state().
maybe_dispatch_guild_sync(SessionId, SessionData, GuildId, Sessions, State) ->
    case session_passive:is_guild_synced(GuildId, SessionData) of
        true ->
            State;
        false ->
            dispatch_guild_sync(SessionId, SessionData, GuildId, Sessions, State)
    end.

-spec handle_send_members_chunk(session_id(), map(), guild_state()) -> ok.
handle_send_members_chunk(SessionId, ChunkData, State) ->
    case guild_session(SessionId, State) of
        {GuildId, _Sessions, SessionData} ->
            SessionPid = maps:get(pid, SessionData, undefined),
            ChunkWithGuildId = ChunkData#{<<"guild_id">> => integer_to_binary(GuildId)},
            dispatch_members_chunk(SessionPid, ChunkWithGuildId, GuildId);
        undefined ->
            ok
    end.

-spec update_session(session_id(), guild_state(), fun((map()) -> map())) -> guild_state().
update_session(SessionId, State, Fun) ->
    Sessions = maps:get(sessions, State, #{}),
    case maps:get(SessionId, Sessions, undefined) of
        undefined -> State;
        SessionData -> State#{sessions => Sessions#{SessionId => Fun(SessionData)}}
    end.

-spec guild_session(session_id(), guild_state()) -> {guild_id(), map(), map()} | undefined.
guild_session(SessionId, State) ->
    case guild_id(State) of
        undefined ->
            undefined;
        GuildId ->
            find_session_in_guild(SessionId, GuildId, State)
    end.

-spec find_session_in_guild(session_id(), guild_id(), guild_state()) ->
    {guild_id(), map(), map()} | undefined.
find_session_in_guild(SessionId, GuildId, State) ->
    Sessions = maps:get(sessions, State, #{}),
    case maps:get(SessionId, Sessions, undefined) of
        undefined -> undefined;
        SessionData -> {GuildId, Sessions, SessionData}
    end.

-spec guild_id(guild_state()) -> guild_id() | undefined.
guild_id(State) ->
    snowflake_id:parse_optional(maps:get(id, State, undefined)).

-spec dispatch_guild_sync(session_id(), map(), guild_id(), map(), guild_state()) ->
    guild_state().
dispatch_guild_sync(SessionId, SessionData, GuildId, Sessions, State) ->
    case {session_user_id(SessionData), maps:get(pid, SessionData, undefined)} of
        {UserId, SessionPid} when is_integer(UserId), UserId > 0, is_pid(SessionPid) ->
            GuildData = guild_data:get_guild_state(UserId, State),
            Encoded =
                {pre_encoded,
                    iolist_to_binary(
                        json:encode(guild_data_wire:payload(GuildData), fun json:encode_value/2)
                    )},
            gateway_dispatch_relay:dispatch(SessionPid, guild_sync, Encoded, GuildId),
            NewSD = session_passive:mark_guild_synced(GuildId, SessionData),
            State#{sessions => Sessions#{SessionId => NewSD}};
        _ ->
            State
    end.

-spec force_guild_sync_session(session_id(), guild_id(), {non_neg_integer(), guild_state()}) ->
    {non_neg_integer(), guild_state()}.
force_guild_sync_session(SessionId, GuildId, {Count, State}) ->
    Sessions = maps:get(sessions, State, #{}),
    case maps:get(SessionId, Sessions, undefined) of
        SessionData when is_map(SessionData) ->
            maybe_force_guild_sync_session(SessionId, SessionData, GuildId, Sessions, Count, State);
        _ ->
            {Count, State}
    end.

-spec maybe_force_guild_sync_session(
    session_id(), map(), guild_id(), map(), non_neg_integer(), guild_state()
) -> {non_neg_integer(), guild_state()}.
maybe_force_guild_sync_session(SessionId, SessionData, GuildId, Sessions, Count, State) ->
    case {session_user_id(SessionData), maps:get(pid, SessionData, undefined)} of
        {UserId, SessionPid} when is_integer(UserId), UserId > 0, is_pid(SessionPid) ->
            {Count + 1, dispatch_guild_sync(SessionId, SessionData, GuildId, Sessions, State)};
        _ ->
            {Count, State}
    end.

-spec session_user_id(map()) -> integer() | undefined.
session_user_id(SessionData) ->
    snowflake_id:parse_optional(maps:get(user_id, SessionData, undefined)).

-spec dispatch_members_chunk(term(), map(), guild_id()) -> ok.
dispatch_members_chunk(SessionPid, ChunkWithGuildId, GuildId) when is_pid(SessionPid) ->
    gateway_dispatch_relay:dispatch(SessionPid, guild_members_chunk, ChunkWithGuildId, GuildId);
dispatch_members_chunk(_SessionPid, _ChunkWithGuildId, _GuildId) ->
    ok.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

set_session_active_guild_missing_session_test() ->
    State = #{sessions => #{}},
    Result = set_session_active_guild(<<"nonexistent">>, 42, State),
    ?assertEqual(State, Result).

set_session_passive_guild_missing_session_test() ->
    State = #{sessions => #{}},
    Result = set_session_passive_guild(<<"nonexistent">>, 42, State),
    ?assertEqual(State, Result).

is_session_active_missing_session_test() ->
    State = #{id => 42, sessions => #{}},
    ?assertEqual(false, is_session_active(<<"nonexistent">>, State)).

force_guild_sync_all_dispatches_even_when_already_synced_test() ->
    drain_mailbox(),
    GuildId = 100,
    SessionId = <<"session-1">>,
    SessionData = session_passive:mark_guild_synced(GuildId, #{
        user_id => 200,
        pid => self()
    }),
    State = (force_sync_test_state(GuildId))#{
        sessions => #{SessionId => SessionData}
    },
    {Count, SyncedState} = force_guild_sync_all(State),
    ?assertEqual(1, Count),
    SyncedSessions = maps:get(sessions, SyncedState),
    ?assert(session_passive:is_guild_synced(GuildId, maps:get(SessionId, SyncedSessions))),
    receive
        {'$gen_cast', {dispatch, guild_sync, {pre_encoded, Payload}}} ->
            Decoded = json:decode(Payload),
            ?assertEqual(<<"100">>, maps:get(<<"id">>, Decoded))
    after 100 ->
        ?assert(false, guild_sync_not_dispatched)
    end.

force_sync_test_state(GuildId) ->
    ViewPerm = constants:view_channel_permission(),
    #{
        id => GuildId,
        member_presence => ets:new(test_force_sync_member_presence, [set, public]),
        sessions => #{},
        data => #{
            <<"guild">> => #{<<"name">> => <<"Fluxer">>},
            <<"roles">> => [
                #{
                    <<"id">> => integer_to_binary(GuildId),
                    <<"permissions">> => integer_to_binary(ViewPerm)
                }
            ],
            <<"channels">> => [],
            <<"members">> => [
                #{
                    <<"user">> => #{<<"id">> => <<"200">>},
                    <<"roles">> => [integer_to_binary(GuildId)],
                    <<"joined_at">> => <<"2024-01-01T00:00:00Z">>
                }
            ],
            <<"emojis">> => [],
            <<"stickers">> => []
        }
    }.

drain_mailbox() ->
    receive
        _ -> drain_mailbox()
    after 0 ->
        ok
    end.

-endif.
