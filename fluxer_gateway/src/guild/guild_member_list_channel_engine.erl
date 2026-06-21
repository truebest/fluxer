%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_member_list_channel_engine).
-typing([eqwalizer]).

-export([
    ref/2,
    is_engine_list/2,
    ensure/2,
    rebuild/2,
    rebuild_all/1,
    rebuild_channels/2,
    drop/2,
    destroy_all/1,
    sync_online/3,
    update_user/3,
    update_user_all/2,
    remove_user/3,
    remove_user_all/2,
    member_index/3,
    set_hoisted_roles_all/2
]).

-type guild_state() :: map().
-type list_id() :: binary().
-type engine_ref() :: ets:table().

-export_type([guild_state/0, list_id/0, engine_ref/0]).

-define(ENGINES_KEY, channel_member_list_engines).

-spec ref(list_id(), guild_state()) -> engine_ref() | undefined.
ref(ListId, State) ->
    maps:get(ListId, engines(State), undefined).

-spec is_engine_list(list_id(), guild_state()) -> boolean().
is_engine_list(<<"0">>, _State) ->
    false;
is_engine_list(ListId, _State) ->
    channel_id(ListId) =/= undefined.

-spec ensure(list_id(), guild_state()) -> guild_state().
ensure(ListId, State) ->
    case is_engine_list(ListId, State) andalso not maps:is_key(ListId, engines(State)) of
        true -> build(ListId, State);
        false -> State
    end.

-spec rebuild(list_id(), guild_state()) -> guild_state().
rebuild(ListId, State) ->
    case maps:get(ListId, engines(State), undefined) of
        undefined ->
            ensure(ListId, State);
        OldRef ->
            rebuild_existing(ListId, OldRef, State)
    end.

-spec rebuild_existing(list_id(), engine_ref(), guild_state()) -> guild_state().
rebuild_existing(ListId, OldRef, State) ->
    case channel_id(ListId) of
        undefined ->
            drop(ListId, State);
        ChannelId ->
            replace_engine(ListId, ChannelId, OldRef, State)
    end.

-spec replace_engine(list_id(), pos_integer(), engine_ref(), guild_state()) -> guild_state().
replace_engine(ListId, ChannelId, OldRef, State) ->
    NewRef = load_engine(ChannelId, State),
    State1 = put_engines(maps:put(ListId, NewRef, engines(State)), State),
    guild_member_list_engine:destroy(OldRef),
    State1.

-spec rebuild_all(guild_state()) -> guild_state().
rebuild_all(State) ->
    lists:foldl(
        fun rebuild/2,
        State,
        maps:keys(engines(State))
    ).

-spec rebuild_channels([pos_integer()], guild_state()) -> guild_state().
rebuild_channels(ChannelIds, State) ->
    lists:foldl(
        fun rebuild_channel_if_loaded/2,
        State,
        ChannelIds
    ).

-spec rebuild_channel_if_loaded(pos_integer(), guild_state()) -> guild_state().
rebuild_channel_if_loaded(ChannelId, State) ->
    ListId = integer_to_binary(ChannelId),
    case maps:is_key(ListId, engines(State)) of
        true -> rebuild(ListId, State);
        false -> State
    end.

-spec drop(list_id(), guild_state()) -> guild_state().
drop(ListId, State) ->
    Engines = engines(State),
    case maps:get(ListId, Engines, undefined) of
        undefined ->
            State;
        Ref ->
            guild_member_list_engine:destroy(Ref),
            put_engines(maps:remove(ListId, Engines), State)
    end.

-spec destroy_all(guild_state()) -> guild_state().
destroy_all(State) ->
    maps:foreach(
        fun(_ListId, Ref) -> guild_member_list_engine:destroy(Ref) end,
        engines(State)
    ),
    put_engines(#{}, State).

-spec sync_online(integer(), boolean(), guild_state()) -> ok.
sync_online(UserId, IsOnline, State) ->
    maps:foreach(
        fun(_ListId, Ref) ->
            guild_member_list_engine:set_online(Ref, UserId, IsOnline)
        end,
        engines(State)
    ),
    ok.

-spec update_user(integer(), list_id(), guild_state()) -> ok.
update_user(UserId, ListId, State) ->
    case ref(ListId, State) of
        undefined ->
            ok;
        Ref ->
            update_user_in_engine(UserId, ListId, Ref, State)
    end.

-spec update_user_all(integer(), guild_state()) -> ok.
update_user_all(UserId, State) ->
    maps:foreach(
        fun(ListId, _Ref) ->
            ok = update_user(UserId, ListId, State)
        end,
        engines(State)
    ),
    ok.

-spec update_user_in_engine(integer(), list_id(), engine_ref(), guild_state()) -> ok.
update_user_in_engine(UserId, ListId, Ref, State) ->
    case channel_id(ListId) of
        undefined ->
            ok;
        ChannelId ->
            update_user_in_channel(UserId, ChannelId, Ref, State)
    end.

-spec update_user_in_channel(integer(), pos_integer(), engine_ref(), guild_state()) -> ok.
update_user_in_channel(UserId, ChannelId, Ref, State) ->
    Data = maps:get(data, State, #{}),
    case guild_data_index:get_member(UserId, Data) of
        Member when is_map(Member) ->
            upsert_visible_user(UserId, ChannelId, Member, Ref, State);
        _ ->
            guild_member_list_engine:remove_member(Ref, UserId)
    end.

-spec upsert_visible_user(integer(), pos_integer(), map(), engine_ref(), guild_state()) -> ok.
upsert_visible_user(UserId, ChannelId, Member, Ref, State) ->
    case can_view(UserId, ChannelId, Member, State) of
        true ->
            DisplayName = guild_member_list_common:get_member_display_name(Member),
            SortKey = guild_member_list_common:casefold_binary(DisplayName),
            RoleIds = guild_member_list_store:extract_role_ids(Member),
            IsOnline = guild_member_list_connected:user_is_online(UserId, State),
            guild_member_list_engine:update_member(Ref, UserId, SortKey, RoleIds, IsOnline);
        false ->
            guild_member_list_engine:remove_member(Ref, UserId)
    end.

-spec remove_user(integer(), list_id(), guild_state()) -> ok.
remove_user(UserId, ListId, State) ->
    case ref(ListId, State) of
        undefined -> ok;
        Ref -> guild_member_list_engine:remove_member(Ref, UserId)
    end.

-spec remove_user_all(integer(), guild_state()) -> ok.
remove_user_all(UserId, State) ->
    maps:foreach(
        fun(ListId, _Ref) ->
            ok = remove_user(UserId, ListId, State)
        end,
        engines(State)
    ),
    ok.

-spec member_index(list_id(), integer(), guild_state()) -> non_neg_integer() | not_found.
member_index(ListId, UserId, State) ->
    case ref(ListId, State) of
        undefined -> not_found;
        Ref -> guild_member_list_engine:index_of(Ref, UserId)
    end.

-spec set_hoisted_roles_all([integer()], guild_state()) -> boolean().
set_hoisted_roles_all(HoistedRoleIds, State) ->
    {_Roles, Changed} = maps:fold(
        fun fold_hoisted_role_change/3,
        {HoistedRoleIds, false},
        engines(State)
    ),
    Changed.

-spec fold_hoisted_role_change(list_id(), engine_ref(), {[integer()], boolean()}) ->
    {[integer()], boolean()}.
fold_hoisted_role_change(_ListId, Ref, {HoistedRoleIds, AnyChanged}) ->
    Result = guild_member_list_engine:set_hoisted_roles(Ref, HoistedRoleIds),
    {HoistedRoleIds, merge_hoisted_role_result(Result, AnyChanged)}.

-spec merge_hoisted_role_result(changed | unchanged, boolean()) -> boolean().
merge_hoisted_role_result(changed, _AnyChanged) ->
    true;
merge_hoisted_role_result(unchanged, AnyChanged) ->
    AnyChanged.

-spec build(list_id(), guild_state()) -> guild_state().
build(ListId, State) ->
    case channel_id(ListId) of
        undefined ->
            State;
        ChannelId ->
            Ref = load_engine(ChannelId, State),
            put_engines(maps:put(ListId, Ref, engines(State)), State)
    end.

-spec load_engine(pos_integer(), guild_state()) -> engine_ref().
load_engine(ChannelId, State) ->
    Ref = guild_member_list_engine:new(),
    {Tuples, HoistedRoleIds} = build_inputs(ChannelId, State),
    ok = guild_member_list_engine:bulk_load(Ref, Tuples, HoistedRoleIds),
    Ref.

-spec build_inputs(pos_integer(), guild_state()) ->
    {[guild_member_list_store:member_tuple()], [integer()]}.
build_inputs(ChannelId, State) ->
    Data = maps:get(data, State, #{}),
    MemberMap = guild_data_index:member_map(Data),
    ConnectedUserIds = guild_member_list_common:connected_session_user_ids(State),
    PresenceTab = maps:get(member_presence, State),
    BotChannelScopeIndex = bot_channel_scope_index(Data),
    Tuples = maps:fold(
        fun(UserId, Member, Acc) ->
            maybe_prepare_visible_member_tuple(
                UserId,
                Member,
                ChannelId,
                State,
                PresenceTab,
                ConnectedUserIds,
                BotChannelScopeIndex,
                Acc
            )
        end,
        [],
        MemberMap
    ),
    Roles = map_utils:ensure_list(maps:get(<<"roles">>, Data, [])),
    HoistedRoleIds =
        case guild_id(State) of
            GuildId when is_integer(GuildId), GuildId > 0 ->
                guild_member_list_store:prepare_hoisted_role_ids(Roles, GuildId);
            _ ->
                []
        end,
    {Tuples, HoistedRoleIds}.

-spec maybe_prepare_visible_member_tuple(
    integer(),
    map(),
    pos_integer(),
    guild_state(),
    ets:tid() | map(),
    sets:set(integer()),
    map(),
    [guild_member_list_store:member_tuple()]
) -> [guild_member_list_store:member_tuple()].
maybe_prepare_visible_member_tuple(
    UserId, Member, ChannelId, State, PresenceTab, ConnectedUserIds, BotChannelScopeIndex, Acc
) ->
    case can_view(UserId, ChannelId, Member, State, BotChannelScopeIndex) of
        true -> prepare_member_tuple(UserId, Member, PresenceTab, ConnectedUserIds, Acc);
        false -> Acc
    end.

-spec prepare_member_tuple(integer(), map(), ets:tid() | map(), sets:set(integer()), [
    guild_member_list_store:member_tuple()
]) -> [guild_member_list_store:member_tuple()].
prepare_member_tuple(UserId, Member, PresenceTab, ConnectedUserIds, Acc) ->
    DisplayName = guild_member_list_common:get_member_display_name(Member),
    SortKey = guild_member_list_common:casefold_binary(DisplayName),
    RoleIds = guild_member_list_store:extract_role_ids(Member),
    Presence = guild_state_member:lookup_presence(PresenceTab, UserId),
    Status = maps:get(<<"status">>, Presence, <<"offline">>),
    IsConnected = sets:is_element(UserId, ConnectedUserIds),
    IsOnline = IsConnected andalso Status =/= <<"offline">> andalso Status =/= <<"invisible">>,
    [{UserId, SortKey, RoleIds, IsOnline} | Acc].

-spec can_view(integer(), pos_integer(), map(), guild_state()) -> boolean().
can_view(UserId, ChannelId, Member, State) when is_integer(UserId), UserId > 0 ->
    Data = maps:get(data, State, #{}),
    can_view(UserId, ChannelId, Member, State, bot_channel_scope_index(Data));
can_view(_UserId, _ChannelId, _Member, _State) ->
    false.

-spec can_view(integer(), pos_integer(), map(), guild_state(), map()) -> boolean().
can_view(UserId, ChannelId, Member, State, BotChannelScopeIndex) when
    is_integer(UserId), UserId > 0
->
    try
        guild_permissions:can_view_channel(UserId, ChannelId, Member, State) andalso
            bot_channel_scope_allows(UserId, ChannelId, Member, BotChannelScopeIndex)
    catch
        _:_ -> false
    end;
can_view(_UserId, _ChannelId, _Member, _State, _BotChannelScopeIndex) ->
    false.

-spec bot_channel_scope_allows(integer(), pos_integer(), map(), map()) -> boolean().
bot_channel_scope_allows(UserId, ChannelId, Member, BotChannelScopeIndex) ->
    case member_is_bot(Member) of
        false ->
            true;
        true ->
            case maps:get(UserId, BotChannelScopeIndex, undefined) of
                undefined -> true;
                ChannelIds when is_map(ChannelIds) -> maps:is_key(ChannelId, ChannelIds);
                _ -> false
            end
    end.

-spec member_is_bot(map()) -> boolean().
member_is_bot(Member) ->
    User = maps:get(<<"user">>, Member, #{}),
    maps:get(<<"bot">>, User, false) =:= true.

-spec bot_channel_scope_index(map()) -> map().
bot_channel_scope_index(Data) when is_map(Data) ->
    Scopes = map_utils:ensure_list(maps:get(<<"bot_channel_scopes">>, Data, [])),
    lists:foldl(fun add_bot_channel_scope/2, #{}, Scopes);
bot_channel_scope_index(_Data) ->
    #{}.

-spec add_bot_channel_scope(term(), map()) -> map().
add_bot_channel_scope(Scope, Acc) when is_map(Scope) ->
    BotUserId = snowflake_id:parse_maybe(maps:get(<<"bot_user_id">>, Scope, undefined)),
    case BotUserId of
        undefined ->
            Acc;
        _ ->
            Acc#{BotUserId => channel_id_map(maps:get(<<"channel_ids">>, Scope, []))}
    end;
add_bot_channel_scope(_Scope, Acc) ->
    Acc.

-spec channel_id_map(term()) -> map().
channel_id_map(ChannelIds) ->
    lists:foldl(
        fun add_channel_id/2,
        #{},
        map_utils:ensure_list(ChannelIds)
    ).

-spec add_channel_id(term(), map()) -> map().
add_channel_id(ChannelIdValue, Acc) ->
    case snowflake_id:parse_maybe(ChannelIdValue) of
        ChannelId when is_integer(ChannelId), ChannelId > 0 -> Acc#{ChannelId => true};
        _ -> Acc
    end.

-spec engines(guild_state()) -> #{list_id() => engine_ref()}.
engines(State) ->
    case maps:get(?ENGINES_KEY, State, #{}) of
        Map when is_map(Map) -> Map;
        _ -> #{}
    end.

-spec put_engines(#{list_id() => engine_ref()}, guild_state()) -> guild_state().
put_engines(Map, State) when map_size(Map) =:= 0 ->
    maps:remove(?ENGINES_KEY, State);
put_engines(Map, State) ->
    State#{?ENGINES_KEY => Map}.

-spec channel_id(list_id()) -> pos_integer() | undefined.
channel_id(ListId) ->
    case snowflake_id:parse_maybe(ListId) of
        Id when is_integer(Id), Id > 0 -> Id;
        _ -> undefined
    end.

-spec guild_id(guild_state()) -> integer() | undefined.
guild_id(State) ->
    snowflake_id:parse_maybe(maps:get(id, State, undefined)).

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

is_engine_list_test() ->
    Any = #{data => #{<<"guild">> => #{<<"features">> => []}}},
    ?assertNot(is_engine_list(<<"0">>, Any)),
    ?assert(is_engine_list(<<"123">>, Any)),
    ?assertNot(is_engine_list(<<"notasnowflake">>, Any)).

ref_reads_engine_map_test() ->
    R = make_ref(),
    State = #{
        data => #{<<"guild">> => #{<<"features">> => []}},
        channel_member_list_engines => #{<<"123">> => R}
    },
    ?assertEqual(R, ref(<<"123">>, State)),
    ?assertEqual(undefined, ref(<<"456">>, State)).

sync_online_noop_without_engines_test() ->
    ?assertEqual(
        ok, sync_online(1, true, #{data => #{<<"guild">> => #{<<"features">> => []}}})
    ).

scoped_bot_visible_only_in_attached_channel_test() ->
    State = bot_scope_test_state([500]),
    BotMember = bot_scope_test_member(200, true),
    HumanMember = bot_scope_test_member(201, false),
    ?assert(can_view(200, 500, BotMember, State)),
    ?assertNot(can_view(200, 600, BotMember, State)),
    ?assert(can_view(201, 600, HumanMember, State)).

legacy_bot_without_scope_stays_visible_test() ->
    State0 = bot_scope_test_state([]),
    State = State0#{data => maps:remove(<<"bot_channel_scopes">>, maps:get(data, State0))},
    BotMember = bot_scope_test_member(200, true),
    ?assert(can_view(200, 500, BotMember, State)),
    ?assert(can_view(200, 600, BotMember, State)).

bot_scope_test_state(AllowedChannelIds) ->
    GuildId = 100,
    Data = guild_data_index:normalize_data(#{
        <<"guild">> => #{
            <<"id">> => integer_to_binary(GuildId),
            <<"owner_id">> => <<"999">>,
            <<"features">> => []
        },
        <<"roles">> => [
            #{
                <<"id">> => integer_to_binary(GuildId),
                <<"permissions">> => integer_to_binary(constants:view_channel_permission())
            }
        ],
        <<"channels">> => [
            #{<<"id">> => <<"500">>, <<"type">> => 0, <<"permission_overwrites">> => []},
            #{<<"id">> => <<"600">>, <<"type">> => 0, <<"permission_overwrites">> => []}
        ],
        <<"members">> => [
            bot_scope_test_member(200, true),
            bot_scope_test_member(201, false)
        ],
        <<"bot_channel_scopes">> => [
            #{
                <<"bot_user_id">> => <<"200">>,
                <<"channel_ids">> => [integer_to_binary(ChannelId) || ChannelId <- AllowedChannelIds]
            }
        ]
    }),
    #{
        id => GuildId,
        data => Data,
        sessions => #{},
        member_presence => #{}
    }.

bot_scope_test_member(UserId, IsBot) ->
    User0 = #{
        <<"id">> => integer_to_binary(UserId),
        <<"username">> => <<"test">>,
        <<"discriminator">> => <<"0">>
    },
    User =
        case IsBot of
            true -> User0#{<<"bot">> => true};
            false -> User0
        end,
    #{<<"user">> => User, <<"roles">> => []}.

-endif.
